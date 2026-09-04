'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_ROOT_MARGIN = '48px';

export type UseInfiniteScrollSentinelOptions = {
  enabled: boolean;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
};

/**
 * IntersectionObserver sentinel for linear infinite-scroll lists.
 * Attach `listRef` to the scroll container and `sentinelRef` to a footer element.
 */
export function useInfiniteScrollSentinel({
  enabled,
  hasMore,
  loading,
  onLoadMore,
  rootMargin = DEFAULT_ROOT_MARGIN,
}: UseInfiniteScrollSentinelOptions): {
  listRef: (node: HTMLElement | null) => void;
  sentinelRef: (node: HTMLElement | null) => void;
} {
  const hasMoreRef = useRef(hasMore);
  const loadingRef = useRef(loading);
  const onLoadMoreRef = useRef(onLoadMore);
  hasMoreRef.current = hasMore;
  loadingRef.current = loading;
  onLoadMoreRef.current = onLoadMore;

  const [listEl, setListEl] = useState<HTMLElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLElement | null>(null);

  const listRef = useCallback((node: HTMLElement | null) => {
    setListEl(node);
  }, []);

  const sentinelRef = useCallback((node: HTMLElement | null) => {
    setSentinelEl(node);
  }, []);

  useEffect(() => {
    if (!enabled || listEl == null || sentinelEl == null) return;

    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        if (!hasMoreRef.current || loadingRef.current) return;
        onLoadMoreRef.current();
      },
      { root: listEl, rootMargin },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  }, [enabled, listEl, sentinelEl, rootMargin]);

  return { listRef, sentinelRef };
}
