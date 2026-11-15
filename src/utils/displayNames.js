// Resolve unique display names for the people in a room.

function baseNameOf(name) {
  const trimmed = String(name || '').trim();
  return trimmed || 'Guest';
}

// participants: [{ userId, name, joinedAt }]
export function resolveDisplayNames(participants) {
  const list = Array.isArray(participants) ? participants : [];
  const groups = new Map();
  for (const participant of list) {
    const key = baseNameOf(participant?.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(participant);
  }

  const resolved = new Map();
  for (const [base, group] of groups) {
    // The longest join order first, then the participant id, so the result is
    // identical on every client even when two people joined at the same time.
    const ordered = [...group].sort((a, b) => {
      const joinedA = Number(a?.joinedAt || 0);
      const joinedB = Number(b?.joinedAt || 0);
      if (joinedA !== joinedB) return joinedA - joinedB;
      return String(a?.userId || '').localeCompare(String(b?.userId || ''));
    });
    ordered.forEach((participant, index) => {
      const userId = participant?.userId;
      if (!userId) return;
      resolved.set(userId, index === 0 ? base : `${base} ${index + 1}`);
    });
  }
  return resolved;
}

// The unique name this participant should show.
export function resolveOwnDisplayName(participants, userId, fallbackName) {
  const resolved = resolveDisplayNames(participants);
  const own = resolved.get(userId);
  if (own) return own;
  return baseNameOf(fallbackName);
}
