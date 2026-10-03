type FollowBottomOptions = { onFollowingChange?: (following: boolean) => void; isActive?: () => boolean };

const BOTTOM_THRESHOLD = 24;
// Fraction of the remaining distance moved per frame while content grows.
const SMOOTH_FACTOR = 0.2;

export const followBottom = (
  viewport: HTMLElement | null | undefined,
  content: HTMLElement | undefined,
  { onFollowingChange, isActive = () => true }: FollowBottomOptions = {},
) => {
  if (!viewport || !content) return;

  let following = true;
  let frame = 0;
  let jump = false;
  let lastScrollTop = viewport.scrollTop;

  const setFollowing = (value: boolean) => {
    if (following === value) return;
    following = value;
    onFollowingChange?.(value);
  };

  // Chases the bottom frame by frame, so continuous growth keeps one animation instead of restarting it.
  const step = () => {
    frame = 0;
    if (!isActive() || !following) return;
    const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    if (jump || distance <= 1) {
      jump = false;
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTop += Math.ceil(distance * SMOOTH_FACTOR);
      frame = requestAnimationFrame(step);
    }
    lastScrollTop = viewport.scrollTop;
  };

  const scrollToBottom = (instant = false) => {
    if (!following || !isActive()) return;
    if (instant) jump = true;
    if (frame) return;
    frame = requestAnimationFrame(step);
  };

  const onScroll = () => {
    const currentScrollTop = viewport.scrollTop;
    const distanceToBottom = viewport.scrollHeight - viewport.clientHeight - currentScrollTop;

    if (following) {
      if (currentScrollTop < lastScrollTop - 2 && distanceToBottom > BOTTOM_THRESHOLD) {
        setFollowing(false);
        jump = false;
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
  const observer = new ResizeObserver(() => scrollToBottom());
  observer.observe(viewport);
  observer.observe(content);
  viewport.addEventListener('scroll', onScroll, { passive: true });
  onFollowingChange?.(true);
  scrollToBottom(true);

  return {
    resume: () => {
      setFollowing(true);
      scrollToBottom(true);
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
