// Sub-domain availability check on the sign-up form (views/signup.ejs). Progressive: the form works without it.
(function () {
  var input = document.getElementById('slug');
  var msg = document.getElementById('slug-msg');
  if (!input || !msg) return;
  var timer = null;
  var seq = 0;

  function show(ok, text) {
    msg.textContent = text;
    msg.className = ok ? 'ok' : 'no';
  }

  input.addEventListener('input', function () {
    input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    clearTimeout(timer);
    var v = input.value;
    if (v.length < 3) { msg.textContent = ''; msg.className = ''; return; }
    timer = setTimeout(function () {
      var mine = ++seq;
      fetch(input.getAttribute('data-check') + '?slug=' + encodeURIComponent(v), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (mine === seq) show(j.ok, j.message); })
        .catch(function () { if (mine === seq) { msg.textContent = ''; msg.className = ''; } });
    }, 350);
  });

  // Suggest an address from the shop name until the owner types their own.
  var name = document.getElementById('name');
  var touched = input.value !== '';
  input.addEventListener('keydown', function () { touched = true; });
  if (name) {
    name.addEventListener('input', function () {
      if (touched) return;
      var s = name.value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      input.value = s;
      input.dispatchEvent(new Event('input'));
    });
  }
})();
