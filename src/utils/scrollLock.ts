let lockCount = 0;
let scrollY = 0;
let originalOverflow = '';
let originalTouchAction = '';
let originalHeight = '';
let originalPosition = '';
let originalTop = '';
let originalWidth = '';

export function lockBodyScroll(): void {
  if (typeof document === 'undefined') return;

  if (lockCount === 0) {
    scrollY = window.scrollY || window.pageYOffset;
    const body = document.body;
    originalOverflow = body.style.overflow;
    originalTouchAction = body.style.touchAction;
    originalHeight = body.style.height;
    originalPosition = body.style.position;
    originalTop = body.style.top;
    originalWidth = body.style.width;

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.height = '100%';
    body.style.overflow = 'hidden';
    body.style.touchAction = 'none';
  }

  lockCount++;
}

export function unlockBodyScroll(): void {
  if (typeof document === 'undefined') return;

  if (lockCount <= 1) {
    const body = document.body;
    body.style.position = originalPosition || '';
    body.style.top = originalTop || '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = originalWidth || '';
    body.style.height = originalHeight || '';
    body.style.overflow = originalOverflow || '';
    body.style.touchAction = originalTouchAction || '';

    window.scrollTo(0, scrollY);
    lockCount = 0;
  } else {
    lockCount--;
  }
}
