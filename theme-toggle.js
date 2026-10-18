(() => {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('[data-theme-choice]')];
  if (!buttons.length) return;

  const setTheme = (theme, persist = true) => {
    const selected = theme === 'blue' ? 'blue' : 'matcha';
    root.dataset.theme = selected;
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === selected));
    });
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = selected === 'blue' ? '#eef4fa' : '#f1f3e9';
    if (persist) {
      try { localStorage.setItem('yizima-theme', selected); } catch (_) { /* Keep the current page usable when storage is unavailable. */ }
    }
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
  });
  setTheme(root.dataset.theme, false);
})();
