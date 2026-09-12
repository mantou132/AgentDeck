export const followBottom = (
  viewport: HTMLElement | null | undefined,
  content: HTMLElement | undefined,
  onFollowingChange?: (following: boolean) => void,
) => {
  if (!viewport || !content) return;

  let following = true;
  let frame = 0;

  const setFollowing = (value: boolean) => {
    if (following === value) return;
    following = value;
    onFollowingChange?.(value);
  };

  const scrollToBottom = () => {
    if (!following) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      viewport.scrollTop = viewport.scrollHeight;
    });
  };

  const onScroll = () => {
    setFollowing(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4);
    if (!following) cancelAnimationFrame(frame);
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
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
    },
  };
};
