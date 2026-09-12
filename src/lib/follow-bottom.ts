const BOTTOM_THRESHOLD = 24;

export const followBottom = (
  viewport: HTMLElement | null | undefined,
  content: HTMLElement | undefined,
  {
    onFollowingChange,
    isActive = () => true,
  }: { onFollowingChange?: (following: boolean) => void; isActive?: () => boolean } = {},
) => {
  if (!viewport || !content) return;

  let following = true;
  let frame = 0;
  let lastScrollTop = viewport.scrollTop;

  const setFollowing = (value: boolean) => {
    if (following === value) return;
    following = value;
    onFollowingChange?.(value);
  };

  const scrollToBottom = () => {
    if (!following || !isActive()) return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!isActive() || !following) return;
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop = viewport.scrollTop;
    });
  };

  const onScroll = () => {
    const currentScrollTop = viewport.scrollTop;
    const distanceToBottom = viewport.scrollHeight - viewport.clientHeight - currentScrollTop;

    if (following) {
      if (currentScrollTop < lastScrollTop - 2 && distanceToBottom > BOTTOM_THRESHOLD) {
        setFollowing(false);
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      } else if (distanceToBottom > 0) {
        scrollToBottom();
      }
    } else if (distanceToBottom <= BOTTOM_THRESHOLD) {
      setFollowing(true);
      scrollToBottom();
    }

    lastScrollTop = currentScrollTop;
  };

  // Also catches delayed Markdown, image and diff layout changes.
  const observer = new ResizeObserver(scrollToBottom);
  observer.observe(viewport);
  observer.observe(content);
  viewport.addEventListener('scroll', onScroll, { passive: true });
  onFollowingChange?.(true);
  scrollToBottom();

  return {
    resume: () => {
      setFollowing(true);
      scrollToBottom();
    },
    disconnect: () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
    },
  };
};
