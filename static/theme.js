(function() {
  function getStoredTheme() {
    try {
      return localStorage.getItem('theme');
    } catch (_e) {
      return null;
    }
  }

  function setStoredTheme(value) {
    try {
      localStorage.setItem('theme', value);
    } catch (_e) {
      // Ignore storage failures (private mode, blocked storage).
    }
  }

  function updateIcon(isDark) {
    document.querySelectorAll('#theme-toggle, .theme-toggle-btn').forEach(function(btn) {
      var icon = btn.querySelector('i');
      if (icon) {
        icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
      }
      btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    });
    var label = document.getElementById('theme-label');
    if (label) label.textContent = isDark ? 'Light mode' : 'Dark mode';
  }

  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark-theme', isDark);
    updateIcon(isDark);
  }

  function toggleTheme() {
    var isDark = document.documentElement.classList.toggle('dark-theme');
    setStoredTheme(isDark ? 'dark' : 'light');
    updateIcon(isDark);
  }

  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  var stored = getStoredTheme();
  applyTheme(stored === 'dark' || (!stored && mq.matches));

  document.addEventListener('DOMContentLoaded', function() {
    updateIcon(document.documentElement.classList.contains('dark-theme'));

    // Wire click listeners here — inline onclick is blocked by CSP (no 'unsafe-inline')
    document.querySelectorAll('#theme-toggle, .theme-toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', toggleTheme);
    });
  });

  // Follow OS changes when user has no stored preference
  var onSchemeChange = function(e) {
    if (!getStoredTheme()) applyTheme(e.matches);
  };

  if (mq.addEventListener) {
    mq.addEventListener('change', onSchemeChange);
  } else if (mq.addListener) {
    // Safari < 14 fallback.
    mq.addListener(onSchemeChange);
  }
})();
