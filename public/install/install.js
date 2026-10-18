// Setup page (views/install.ejs): "Hiện mật khẩu" toggle and "Sao chép mã máy". Progressive: the form works without it.
(function () {
  var toggle = document.getElementById('show-pw');
  if (toggle) {
    toggle.addEventListener('change', function () {
      ['password', 'password2', 'token'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.type = toggle.checked ? 'text' : 'password';
      });
    });
  }
  var btn = document.getElementById('copy-machine-id');
  var code = document.getElementById('machine-id');
  var note = document.getElementById('copy-note');
  if (btn && code) {
    btn.addEventListener('click', function () {
      var text = code.textContent.trim();
      var done = function (ok) { if (note) note.textContent = ok ? 'Đã sao chép.' : 'Không sao chép được: bôi đen mã rồi nhấn Ctrl+C.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        var r = document.createRange();
        r.selectNodeContents(code);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        try { done(document.execCommand('copy')); } catch (e) { done(false); }
      }
    });
  }
})();
