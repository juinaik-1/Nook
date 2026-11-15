import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config, ensureDataDirectories } from "./config.js";
import {
  attachSession,
  authenticateGoogleIdToken,
  issueSessionToken,
  requireSession,
} from "./auth.js";
import {
  completeDriveAuthorization,
  createDriveAuthorization,
  disconnectDrive,
  getDriveAccessToken,
  isDriveConnected,
} from "./driveOAuth.js";
import {
  cancelJob,
  cleanupExpiredJobs,
  createJob,
  getJob,
  getUserReservedBytes,
  requestJobConversion,
} from "./jobs.js";
import {
  deleteAllUserStreams,
  deleteExpiredStreams,
  deleteStream,
  getStream,
  getStreamAccess,
  getUserActiveStreams,
  getUserStorageUsed,
  registerDriveStream,
  serveStream,
} from "./streams.js";
import { startDiskCleanup } from "./cleanup.js";
import { isValidJobId, isValidStreamId, validateUrl } from "./security.js";
import {
  addQueueItem,
  advanceQueue,
  cleanupExpiredQueues,
  clearQueue,
  getQueue,
  isValidRoomId,
  patchQueueItem,
  removeQueueItem,
} from "./queues.js";

ensureDataDirectories();

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
    const isLanAddress = /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(origin);
    if (isLoopback || isLanAddress || config.frontendOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS'));
  },
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Range', 'Access-Control-Request-Private-Network'],
  exposedHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length'],
  credentials: true,
  maxAge: 600,
}));
app.use(express.json({ limit: "128kb" }));

const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.auth,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Try again shortly." },
});
const driveLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.drive,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many Google Drive requests. Try again shortly." },
});
const jobsLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.jobs,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many conversion requests. Try again shortly." },
});
// The media route streams bytes, not API calls. It has its own and much
// larger budget, and it is skipped by the API limiter below, so one viewer
// pulling a video cannot exhaust the budget for everyone else behind the same
// address.
const mediaLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.media,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many stream requests. Try again shortly." },
});
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.api,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Range requests for the media are not API calls. Counting them used to let
  // a single viewer exhaust the budget and rate limit the session check.
  // The queue has its own budget: every participant polls it when the queue
  // changes, and behind a reverse proxy all of them share one address.
  skip: (req) => req.path.startsWith("/stream/") || req.path.startsWith("/rooms/"),
  message: { error: "Too many API requests. Try again shortly." },
});
const queueLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.queue,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many queue requests. Try again shortly." },
});

app.use("/api/auth", authLimiter);
app.use("/api/drive", driveLimiter);
app.use("/api/stream", mediaLimiter);
app.use("/api", apiLimiter);
app.use("/api", (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  const cleanPath = req.path.replace(/\/+$/, "");
  // The queue routes are: /rooms/:roomId/queue, /rooms/:roomId/queue/advance
  // and /rooms/:roomId/queue/:itemId. The item id segment needs its own
  // slash, otherwise PATCH and DELETE on an item were treated as protected
  // routes and a guest was told to sign in.
  const isQueueRoute = /^\/rooms\/[A-Z0-9]{4,8}\/queue(\/advance|\/[a-f0-9]{32})?$/i.test(cleanPath);
  const isPublic =
    cleanPath === "/health" ||
    (cleanPath === "/auth/google" && req.method === "POST") ||
    (cleanPath === "/auth/google/callback" && req.method === "GET") ||
    /^\/streams\/[a-f0-9]{32}\/access$/i.test(cleanPath) ||
    (cleanPath.startsWith("/stream/") && ["GET", "HEAD"].includes(req.method)) ||
    (isQueueRoute && req.method === "GET");

  if (isQueueRoute) return attachSession(req, res, next);
  return isPublic ? next() : requireSession(req, res, next);
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, status: "healthy" }),
);

app.post("/api/auth/google", async (req, res, next) => {
  try {
    const user = await authenticateGoogleIdToken(req.body?.credential);
    return res.json({
      token: issueSessionToken(user),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    });
  } catch (error) {
    if (!error.status) error.status = 401;
    return next(error);
  }
});

app.get("/api/auth/google/callback", async (req, res) => {
  const frontend = config.frontendOrigins[0];
  if (req.query.error) return res.redirect(`${frontend}/?drive=cancelled`);
  try {
    const user = await completeDriveAuthorization(
      req.query.state,
      req.query.code,
    );
    const origin = user.origin && config.frontendOrigins.includes(user.origin)
      ? user.origin
      : frontend;
    const target = new URL(user.returnTo, origin);
    target.searchParams.set("drive", "connected");
    target.searchParams.set("account", user.email);
    return res.redirect(target.toString());
  } catch {
    const target = new URL("/", frontend);
    target.searchParams.set("drive", "error");
    return res.redirect(target.toString());
  }
});

app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));
app.post("/api/drive/connect", (req, res, next) => {
  try {
    const origin = typeof req.get("origin") === "string" && config.frontendOrigins.includes(req.get("origin"))
      ? req.get("origin")
      : "";
    return res.json({
      authUrl: createDriveAuthorization(req.user, req.body?.returnTo || "/", origin),
    });
  } catch (error) {
    return next(error);
  }
});
app.get("/api/drive/picker-token", async (req, res, next) => {
  try {
    if (!isDriveConnected(req.user.id)) {
      return res
        .status(409)
        .json({ error: "Connect Google Drive before opening the picker." });
    }
    return res.json({ accessToken: await getDriveAccessToken(req.user.id) });
  } catch (error) {
    return next(error);
  }
});
app.post("/api/drive/disconnect", async (req, res, next) => {
  try {
    await disconnectDrive(req.user.id);
    return res.json({ disconnected: true });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/streams", async (req, res, next) => {
  try {
    const result = await registerDriveStream(req.user.id, req.body?.fileId);
    return res.status(201).json({
      streamId: result.streamId,
      name: result.name,
      playable: result.playable,
      reason: result.reason,
      audioTracks: result.audioTracks,
    });
  } catch (error) {
    return next(error);
  }
});
// The converted videos this account still has on the server. The list comes
// from the server's own registry and the files on disk, so it needs no
// database.
app.get("/api/streams/mine", (req, res) =>
  res.json(getUserActiveStreams(req.user.id)),
);
app.post("/api/streams/:streamId/access", (req, res) => {
  if (!isValidStreamId(req.params.streamId))
    return res.status(400).json({ error: "Invalid stream ID." });
  const result = getStreamAccess(req.params.streamId);
  return result
    ? res.json(result)
    : res.status(404).json({ error: "Stream not found or expired." });
});
// How much storage this account has used and how much it is allowed. The
// numbers come from the stream registry and the in-flight jobs, so no
// database is involved.
app.get("/api/storage", (req, res) =>
  res.json({
    usedBytes: getUserStorageUsed(req.user.id),
    reservedBytes: getUserReservedBytes(req.user.id),
    quotaBytes: config.perUserQuotaBytes,
    fileCount: getUserActiveStreams(req.user.id).length,
  }),
);
// Drop every converted video this account still has. The user reaches for
// this when they are over quota or want a clean slate. The file is removed
// where it can be; a file a live stream still serves is left for the cleanup
// sweep.
app.delete("/api/streams/mine", (req, res) => {
  const result = deleteAllUserStreams(req.user.id);
  return res.json({
    deleted: result.deleted,
    bytesFreed: result.bytesFreed,
  });
});
app.delete("/api/streams/:streamId", (req, res) => {
  if (!isValidStreamId(req.params.streamId))
    return res.status(400).json({ error: "Invalid stream ID." });
  const record = getStream(req.params.streamId);
  if (!record) return res.status(404).json({ error: "Stream not found." });
  if (record.ownerUserId !== req.user.id)
    return res
      .status(403)
      .json({ error: "Only the stream owner can delete it." });
  deleteStream(record.streamId);
  return res.json({ deleted: true });
});
app.get("/api/stream/:streamId", serveStream);
app.head("/api/stream/:streamId", serveStream);

app.post("/api/jobs", jobsLimiter, async (req, res, next) => {
  try {
    return res.status(202).json(
      await createJob(
        req.user.id,
        {
          streamId: req.body?.streamId,
          url: req.body?.url,
        },
        {
          // Passing the options up front removes the interactive options
          // round-trip, so the job starts converting as soon as it is analysed.
          autoStart: req.body?.autoStart === true,
          audioTrack: req.body?.audioTrack,
          resolution: req.body?.resolution,
        },
      ),
    );
  } catch (error) {
    return next(error);
  }
});
app.get("/api/jobs/:jobId", (req, res) => {
  if (!isValidJobId(req.params.jobId))
    return res.status(400).json({ error: "Invalid job ID." });
  const job = getJob(req.params.jobId, req.user.id);
  return job
    ? res.json(job)
    : res.status(404).json({ error: "Job not found." });
});
app.post("/api/jobs/:jobId/convert", jobsLimiter, (req, res, next) => {
  if (!isValidJobId(req.params.jobId))
    return res.status(400).json({ error: "Invalid job ID." });
  try {
    return res
      .status(202)
      .json(requestJobConversion(req.params.jobId, req.user.id, req.body));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/jobs/:jobId", (req, res) => {
  if (!isValidJobId(req.params.jobId))
    return res.status(400).json({ error: "Invalid job ID." });
  const job = cancelJob(req.params.jobId, req.user.id);
  return job
    ? res.json(job)
    : res.status(404).json({ error: "Job not found." });
});

// Room playback queue. The backend owns it so requireSession gives real
app.get("/api/rooms/:roomId/queue", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  try {
    return res.json(await getQueue(req.params.roomId.toUpperCase()));
  } catch (error) { return next(error); }
});
app.post("/api/rooms/:roomId/queue", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  try {
    const body = req.body || {};
    const kind = body.kind;
    if (!['url', 'stream', 'job'].includes(kind)) {
      return res.status(400).json({ error: "kind must be url, stream, or job." });
    }
    const actorId = (typeof body.addedBy === 'string' && body.addedBy.trim())
      ? body.addedBy.trim().slice(0, 64)
      : req.user?.id;
    if (!actorId) {
      return res.status(400).json({ error: "A participant id is required to add to the queue." });
    }
    // Only valid HTTP(S) URLs may be queued.
    if ((kind === 'url' || kind === 'job') && typeof body.url === 'string' && body.url.trim()) {
      try { validateUrl(body.url.trim()); } catch (validationError) {
        return res.status(400).json({ error: validationError.message || "Enter a valid HTTP or HTTPS URL." });
      }
    } else if (kind === 'url' || kind === 'job') {
      return res.status(400).json({ error: "A valid url is required." });
    }
    if (kind === 'job') {
      const current = await getQueue(req.params.roomId.toUpperCase());
      const userPending = current.items.filter(
        (item) => item.kind === 'job' && item.addedBy === actorId && item.status === 'pending',
      ).length;
      if (userPending >= 1) {
        return res.status(409).json({ error: "You already have a conversion in progress in this queue." });
      }
    }
    if (kind === 'stream') {
      const streamId = body.streamId;
      if (typeof streamId !== 'string' || !/^[a-f0-9]{32}$/.test(streamId)) {
        return res.status(400).json({ error: "A valid streamId is required." });
      }
      const record = getStream(streamId);
      // A guest owns no streams, so only a signed-in owner may queue one.
      if (!req.user || !record || record.ownerUserId !== req.user.id) {
        return res.status(403).json({ error: "Only the stream owner can queue it." });
      }
    }
    const result = await addQueueItem(req.params.roomId.toUpperCase(), {
      kind,
      url: body.url,
      streamId: body.streamId,
      jobId: body.jobId,
      title: body.title,
      author: body.author,
      thumbnailUrl: body.thumbnailUrl,
      addedBy: actorId,
      status: body.status,
    }, body.expectedVersion);
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/rooms/:roomId/queue/:itemId", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  if (!/^[a-f0-9]{32}$/.test(req.params.itemId)) return res.status(400).json({ error: "Invalid item ID." });
  try {
    const result = await patchQueueItem(
      req.params.roomId.toUpperCase(),
      req.params.itemId,
      req.body || {},
      req.body?.expectedVersion,
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/rooms/:roomId/queue/:itemId", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  if (!/^[a-f0-9]{32}$/.test(req.params.itemId)) return res.status(400).json({ error: "Invalid item ID." });
  try {
    const result = await removeQueueItem(
      req.params.roomId.toUpperCase(),
      req.params.itemId,
      req.body?.expectedVersion,
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/rooms/:roomId/queue", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  try {
    return res.json(await clearQueue(req.params.roomId.toUpperCase(), req.body?.expectedVersion));
  } catch (error) {
    return next(error);
  }
});

// Idempotent advance: only advances if finishedItemId is still at the head.
app.post("/api/rooms/:roomId/queue/advance", queueLimiter, async (req, res, next) => {
  if (!isValidRoomId(req.params.roomId)) return res.status(400).json({ error: "Invalid room ID." });
  try {
    const finishedItemId = req.body?.finishedItemId;
    const result = await advanceQueue(
      req.params.roomId.toUpperCase(),
      finishedItemId,
      req.body?.expectedVersion,
    );
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || error.statusCode || 500);
  // Log the real cause so a masked 500 can be diagnosed from the console.
  if (status >= 500) {
    console.error(`[${_req.method} ${_req.originalUrl}] ${status}`, error);
  }
  // A blocked origin is a client-side configuration problem, not a server
  // failure. Answering 500 hides the reason and makes it look like the request
  // itself failed.
  if (error.message === "Blocked by CORS") {
    return res.status(403).json({
      error: `Request blocked: this origin is not allowed to call the API. Add it to FRONTEND_ORIGINS.`,
    });
  }
  // A message that was written for the user is safe to pass through even when
  // it arrived without a status, so a bad file selection explains itself
  // instead of reporting an opaque failure.
  if (status >= 500 && error.exposeToUser) {
    return res.status(status).json({ error: error.message });
  }
  return res.status(status).json({
    error:
      status >= 500 ? "The request could not be completed." : error.message,
  });
});

const cleanupTimer = setInterval(() => {
  try {
    cleanupExpiredJobs();
    deleteExpiredStreams();
    cleanupExpiredQueues();
  } catch {
    console.error("Scheduled expired-file cleanup failed.");
  }
}, 10 * 60_000);
cleanupTimer.unref?.();
// Remove the files a conversion left behind. Runs on startup and then every
// hour, so a cancelled or interrupted conversion cannot fill the disk.
startDiskCleanup();
cleanupExpiredJobs();
deleteExpiredStreams();
cleanupExpiredQueues();

app.listen(config.port, () =>
  console.log(`Nook API listening on port ${config.port}`),
);
