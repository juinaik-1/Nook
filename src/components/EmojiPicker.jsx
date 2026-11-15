import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Smile, X } from 'lucide-react';
import { Button, inputClass } from './ui';
import { cn } from '../utils/cn';
import {
  EMOJI_CATEGORIES,
  loadRecent,
  recordRecent,
  searchEmoji,
} from '../utils/emoji';

export default function EmojiPicker({ onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(() => loadRecent());
  const searchRef = useRef(null);
  const containerRef = useRef(null);

  // Focus the search field when the picker opens.
  useEffect(() => {
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Close on Escape. The textarea keeps focus because the picker never
  // steals it: every button uses onMouseDown with preventDefault.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handlePick = useCallback((char) => {
    onPick?.(char);
    setRecent(recordRecent(char));
  }, [onPick]);

  const trimmed = query.trim();
  const showSearch = trimmed.length > 0;
  const results = showSearch ? searchEmoji(trimmed) : null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 z-50 mb-2 flex w-full max-w-sm flex-col overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      role="dialog"
      aria-label="Emoji picker"
      // Keep the textarea focused so the caret position is preserved.
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* Search + close */}
      <div className="flex items-center gap-2 border-b border-zinc-200/80 px-3 py-2 dark:border-zinc-800">
        <Search className="h-4 w-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
        <input
          ref={searchRef}
          className={cn('h-8 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-zinc-400 dark:text-zinc-100')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search emoji"
          aria-label="Search emoji"
        />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close picker">
          <X className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>

      <div className="max-h-72 overflow-y-auto p-2 scrollbar-thin">
        {/* Recently used */}
        {recent.length > 0 && !showSearch ? (
          <section className="mb-2">
            <p className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Recent
            </p>
            <div className="flex flex-wrap gap-1">
              {recent.map((char) => (
                <button
                  key={`recent-${char}`}
                  type="button"
                  title={char}
                  onClick={() => handlePick(char)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors duration-150 ease-out hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {char}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {showSearch ? (
          <section>
            <p className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {results.length} result{results.length === 1 ? '' : 's'}
            </p>
            <div className="flex flex-wrap gap-1">
              {results.map((item) => (
                <button
                  key={item.char + item.name}
                  type="button"
                  title={item.name}
                  onClick={() => handlePick(item.char)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors duration-150 ease-out hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {item.char}
                </button>
              ))}
            </div>
            {results.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
                No emoji match "{query}".
              </p>
            ) : null}
          </section>
        ) : (
          EMOJI_CATEGORIES.map((category) => (
            <section key={category.id} className="mb-3">
              <p className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                {category.label}
              </p>
              <div className="flex flex-wrap gap-1">
                {category.items.map((item) => (
                  <button
                    key={item.char + item.name}
                    type="button"
                    title={item.name}
                    onClick={() => handlePick(item.char)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-lg leading-none transition-colors duration-150 ease-out hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {item.char}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
