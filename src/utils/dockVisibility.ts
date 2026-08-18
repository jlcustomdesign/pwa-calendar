let openSheetCount = 0;

export function showDockForSheet(): void {
  const dock = document.getElementById('persistent-dock');
  if (!dock) return;

  openSheetCount = Math.max(0, openSheetCount + 1);
  dock.style.display = 'none';
}

export function hideDockForSheet(): void {
  const dock = document.getElementById('persistent-dock');
  if (!dock) return;

  openSheetCount = Math.max(0, openSheetCount - 1);
  if (openSheetCount <= 0) {
    dock.style.display = '';
    openSheetCount = 0;
  }
}
