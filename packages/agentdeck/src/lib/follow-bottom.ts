type FollowBottomOptions = {
  onAwayChange?: (away: boolean) => void;
  isActive?: () => boolean;
};

// Covers Retina subpixel rounding, iOS bottom rubber-band bounce, and clamping when content shrinks.
const BOTTOM_TOLERANCE = 2;
// Re-engage following silently once the user scrolls back down within this distance of the bottom.
const RESUME_THRESHOLD = 8;
// If content grows further than this while a finger is held down, keep the user's spot on release.
const HOLD_CANCEL_THRESHOLD = 24;
// Distance from the bottom before showing a jump-to-latest control, avoiding flicker on small nudges.
const AWAY_THRESHOLD = 48;
// Framerate-independent exponential damping rate (per second) for smooth chasing across 60Hz/120Hz screens.
const SMOOTH_SPEED = 14;

export const followBottom = (
  viewport: HTMLElement | null | undefined,
  content: HTMLElement | undefined,
  { onAwayChange, isActive = () => true }: FollowBottomOptions = {},
) => {
  if (!viewport || !content) return;

  let following = true;
  let away = false;
  let touching = false;
  let jump = false;
  let frame = 0;
  let lastTime = 0;
  let lastScrollTop = viewport.scrollTop;

  const getMaxScrollTop = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const getDistanceToBottom = () => getMaxScrollTop() - viewport.scrollTop;
  // Only smooth-scroll within one viewport height; longer distances jump directly to avoid sweeping past
  // intermediate lazy cards (maps, screens) and rasterizing offscreen charts along the way.
  const shouldSmooth = (distance: number) =>
    distance > BOTTOM_TOLERANCE && viewport.clientHeight > 0 && distance <= viewport.clientHeight;

  const cancelFrame = () => {
    jump = false;
    lastTime = 0;
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const syncAway = () => {
    const next = !following && getDistanceToBottom() > AWAY_THRESHOLD;
    if (away === next) return;
    away = next;
    onAwayChange?.(next);
  };

  const setFollowing = (value: boolean) => {
    if (following === value) return;
    following = value;
    if (!value) cancelFrame();
    syncAway();
  };

  const pinToBottom = () => {
    if (!following || !isActive() || touching) return;
    const maxScrollTop = getMaxScrollTop();
    // Skip redundant writes when already at the bottom so iOS/Android native momentum is never interrupted.
    if (maxScrollTop - viewport.scrollTop <= BOTTOM_TOLERANCE) return;
    viewport.scrollTop = maxScrollTop;
    lastScrollTop = viewport.scrollTop;
  };

  // Chases the moving bottom in one continuous ease-out glide instead of snapping line by line.
  const step = (now: number) => {
    frame = 0;
    if (!isActive() || !following || touching) {
      jump = false;
      lastTime = 0;
      return;
    }
    if (jump) {
      jump = false;
      lastTime = 0;
      pinToBottom();
      return;
    }
    const maxScrollTop = getMaxScrollTop();
    const distance = maxScrollTop - viewport.scrollTop;
    if (distance <= 0.5) {
      lastTime = 0;
      if (distance > 0) {
        viewport.scrollTop = maxScrollTop;
        lastScrollTop = viewport.scrollTop;
      }
      return;
    }
    if (!shouldSmooth(distance)) {
      lastTime = 0;
      viewport.scrollTop = maxScrollTop;
      lastScrollTop = viewport.scrollTop;
      return;
    }
    const dt = lastTime ? Math.min(50, Math.max(0, now - lastTime)) / 1000 : 1 / 60;
    lastTime = now;
    const prev = viewport.scrollTop;
    const delta = Math.max(0.5, distance * (1 - Math.exp(-SMOOTH_SPEED * dt)));
    viewport.scrollTop = Math.min(maxScrollTop, prev + delta);
    if (viewport.scrollTop <= prev) {
      // 1x DPR viewports round fractional scrollTop; advance by 1px to guarantee completion.
      viewport.scrollTop = Math.min(maxScrollTop, prev + 1);
    }
    lastScrollTop = viewport.scrollTop;
    if (maxScrollTop - viewport.scrollTop > 0.5) {
      frame = requestAnimationFrame(step);
    } else {
      lastTime = 0;
    }
  };

  const jumpToBottom = () => {
    if (!following || !isActive() || touching) return;
    pinToBottom();
    // Keep instant pinning active through the next frame so delayed child rendering (e.g. history replay)
    // does not start a smooth glide across the whole timeline.
    jump = true;
    lastTime = 0;
    if (!frame) frame = requestAnimationFrame(step);
  };

  const follow = () => {
    if (!following || !isActive() || touching) return;
    if (jump) {
      pinToBottom();
      return;
    }
    const distance = getDistanceToBottom();
    if (distance <= BOTTOM_TOLERANCE) return;
    if (shouldSmooth(distance)) {
      if (!frame) {
        lastTime = 0;
        frame = requestAnimationFrame(step);
      }
    } else {
      cancelFrame();
      pinToBottom();
    }
  };

  const onScroll = () => {
    const currentScrollTop = viewport.scrollTop;
    const distanceToBottom = getDistanceToBottom();

    if (following) {
      if (currentScrollTop < lastScrollTop && distanceToBottom > BOTTOM_TOLERANCE) {
        setFollowing(false);
      }
    } else if (currentScrollTop > lastScrollTop && distanceToBottom <= RESUME_THRESHOLD) {
      // Silently resume without writing scrollTop so native scroll momentum finishes naturally.
      setFollowing(true);
    } else {
      syncAway();
    }

    lastScrollTop = currentScrollTop;
  };

  const onTouchStart = () => {
    touching = true;
    cancelFrame();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches?.length) return;
    touching = false;
    if (!following) {
      syncAway();
      return;
    }
    if (getDistanceToBottom() > HOLD_CANCEL_THRESHOLD) {
      // User held a finger while content grew underneath or tapped mid-jump; keep their reading spot.
      setFollowing(false);
    } else {
      follow();
    }
  };

  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) cancelFrame();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || !frame) return;
    cancelFrame();
    if (getDistanceToBottom() > HOLD_CANCEL_THRESHOLD) {
      setFollowing(false);
    }
  };

  const observer = new ResizeObserver(() => {
    if (following) {
      follow();
    } else if (getMaxScrollTop() <= BOTTOM_TOLERANCE) {
      setFollowing(true);
    }
    syncAway();
  });
  observer.observe(viewport);
  observer.observe(content);

  const controller = new AbortController();
  const options = { passive: true, signal: controller.signal };
  viewport.addEventListener('scroll', onScroll, options);
  viewport.addEventListener('touchstart', onTouchStart, options);
  viewport.addEventListener('touchend', onTouchEnd, options);
  viewport.addEventListener('touchcancel', onTouchEnd, options);
  viewport.addEventListener('wheel', onWheel, options);
  viewport.addEventListener('pointerdown', onPointerDown, options);
  onAwayChange?.(false);
  jumpToBottom();

  return {
    resume: (smooth = false) => {
      setFollowing(true);
      if (!isActive()) return;
      if (smooth) {
        jump = false;
        follow();
      } else {
        jumpToBottom();
      }
      syncAway();
    },
    disconnect: () => {
      cancelFrame();
      observer.disconnect();
      controller.abort();
    },
  };
};
