import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { sliceGraphemes } from '../utils/graphemes';

function toListMessage(message) {
  return {
    id: message.id || `${message.room_id}-${message.created_at}-${Math.random()}`,
    room_id: message.room_id,
    name: message.name || 'Guest',
    text: message.text || '',
    created_at: message.created_at || new Date().toISOString(),
    type: message.type || 'chat',
    // The database row only carries the display name. The broadcast carries the
    // participant id as well, so a message is grouped with the right person
    // when it arrives live.
    user_id: message.user_id || message.name || 'guest',
  };
}

// Append without repeating a message that is already listed. The same
// message arrives twice: once through the broadcast and once through the
// database change feed.
function appendMessage(current, message) {
  if (current.some((entry) => entry.id === message.id)) return current;
  return [...current, message].slice(-100);
}

export function useChat({ roomId, channel, displayName, userId }) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    setMessages([]);
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !channel) {
      return;
    }

    let active = true;
    const handleMessage = ({ payload }) => {
      if (!active || !payload || payload.room_id !== roomId) {
        return;
      }

      const message = toListMessage({
        ...payload,
        user_id: payload.user_id || payload.name || 'guest',
        room_id: roomId,
        created_at: payload.created_at || new Date().toISOString(),
      });

      setMessages((current) => appendMessage(current, message));
    };

    const handleNotice = ({ payload }) => {
      if (!active || !payload?.text) {
        return;
      }

      const notice = {
        id: `notice-${Date.now()}-${Math.random()}`,
        room_id: roomId,
        name: 'System',
        text: payload.text,
        created_at: new Date().toISOString(),
        type: 'system',
        user_id: 'system',
      };
      setMessages((current) => [...current, notice].slice(-100));
    };

    channel.on('broadcast', { event: 'chat:message' }, handleMessage);
    channel.on('broadcast', { event: 'chat:notice' }, handleNotice);

    return () => {
      active = false;
      if (typeof channel.off === 'function') {
        channel.off('broadcast', { event: 'chat:message' }, handleMessage);
        channel.off('broadcast', { event: 'chat:notice' }, handleNotice);
      }
    };
  }, [channel, roomId]);

  useEffect(() => {
    if (!roomId || !supabase) {
      return;
    }

    let active = true;
    const loadHistory = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) {
        console.error('Unable to load room chat history.', error);
        return;
      }

      if (!active) return;
      // The query returns the newest first, so reverse it to keep the list
      // oldest-first for display. Without this a busy room would show the
      // oldest 100 messages and never the recent ones.
      const history = (data || []).map(toListMessage).reverse();
      setMessages((current) => {
        const byId = new Map(history.map((message) => [message.id, message]));
        current.forEach((message) => byId.set(message.id, message));
        return [...byId.values()].slice(-100);
      });
    };

    void loadHistory().catch((error) => {
      if (active) console.error('Unable to load room chat history.', error);
    });

    const subscription = supabase
      .channel(`messages:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const nextMessage = toListMessage(payload.new);
          setMessages((current) => appendMessage(current, nextMessage));
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(subscription).catch((error) => {
        console.error('Unable to remove the room chat channel.', error);
      });
    };
  }, [roomId]);

  const addSystemMessage = useCallback((text) => {
    if (!text?.trim()) {
      return;
    }

    const systemMessage = {
      id: `system-${Date.now()}-${Math.random()}`,
      room_id: roomId,
      name: 'System',
      text,
      created_at: new Date().toISOString(),
      type: 'system',
      user_id: 'system',
    };

    setMessages((current) => [...current, systemMessage].slice(-100));
  }, [roomId]);

  const sendMessage = async (rawMessage) => {
    const messageText = String(rawMessage || '').trim();
    if (!messageText) {
      return;
    }

    const cleanedText = sliceGraphemes(messageText, 500);
    const payload = {
      room_id: roomId,
      name: displayName || 'Guest',
      text: cleanedText,
      created_at: new Date().toISOString(),
      user_id: userId,
    };

    const showLocalFallback = () => {
      if (channel) {
        channel.send({
          type: 'broadcast',
          event: 'chat:message',
          payload,
        });
      }

      setMessages((current) => [
        ...current,
        toListMessage({ ...payload, id: `local-fallback-${Date.now()}-${Math.random()}` }),
      ].slice(-100));
    };

    if (!supabase) {
      showLocalFallback();
      return;
    }

    try {
      const { error } = await supabase.from('messages').insert([
        {
          room_id: roomId,
          name: displayName || 'Guest',
          text: cleanedText,
        },
      ]);
      if (error) {
        showLocalFallback();
      }
    } catch (error) {
      showLocalFallback();
    }
  };

  return {
    messages,
    sendMessage,
    addSystemMessage,
  };
}
