(function () {
  'use strict';
  var P = PipelineSim;
  var $ = function (id) { return document.getElementById(id); };
  var instrs = [], res = null, cur = 0, timer = null;

  function cfg() {
    return { stages: Number($('stages').value), forwarding: $('fwd').checked, branch: $('branch').value, structural: $('struct').checked };
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; $('btnPlay').textContent = 'Play'; } }

  function simulate(keepCycle) {
    stop();
    var parsed = P.parse($('src').value);
    $('err').textContent = parsed.errors.join('\n');
    if (parsed.errors.length) return;
    if (!parsed.instrs.length) { $('err').textContent = 'Enter at least one instruction.'; return; }
    instrs = parsed.instrs;
    res = P.schedule(instrs, cfg());
    cur = keepCycle ? Math.min(cur, res.stats.total) : 0;
    render();
  }

  function render() {
    renderStats(); renderPipe(); renderNow(); renderEvents();
    $('cycleNow').textContent = 'cycle ' + cur + ' of ' + res.stats.total;
    $('btnNext').disabled = cur >= res.stats.total; $('btnPrev').disabled = cur <= 0; $('btnAll').disabled = cur >= res.stats.total;
    $('btnPlay').disabled = cur >= res.stats.total && !timer;
  }

  function renderStats() {
    var s = res.stats, t = res.totals;
    function st(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
    $('stats').innerHTML = st(s.instructions, 'instructions') + st(s.total, 'total cycles') + st(s.ideal, 'cycles with no stalls') +
      st(s.stalls, 'stall cycles') + st(s.cpi.toFixed(2), 'cycles per instruction') + st(s.speedup.toFixed(2) + 'x', 'speed-up vs no pipeline') +
      st(t.data, 'lost to data hazards') + st(t.control, 'lost to branches') + st(t.structural, 'lost to memory port');
    $('statNote').textContent = 'Without pipelining each instruction would take ' + res.stages.length + ' cycles on its own (' + s.instructions * res.stages.length + ' in total). ' +
      'The best a ' + res.stages.length + '-stage pipeline can do for ' + s.instructions + ' instructions is ' + s.ideal + ' cycles.';
  }

  function renderPipe() {
    var T = res.stats.total, h = '<tr><th class="lbl">Instruction</th>';
    for (var t = 1; t <= T; t++) h += '<th class="' + (t === cur ? 'now' : '') + '">' + t + '</th>';
    h += '</tr>';
    instrs.forEach(function (ins, i) {
      h += '<tr><td class="lbl"><span class="muted">I' + (i + 1) + '</span> ' + ins.text + '</td>';
      for (var t2 = 1; t2 <= T; t2++) {
        var cell = res.cells[i][t2 - 1], cls = '', txt = '';
        if (cell && t2 <= cur) {
          if (cell.bubble) { cls = ' ' + (cell.bubble === 'flush' ? 'flush' : 'bubble'); txt = cell.bubble === 'flush' ? 'flush' : 'wait'; }
          else { cls = ' cell s-' + cell.stage + (cell.stall ? ' stall' : ''); txt = cell.stage + (cell.stall ? '*' : ''); }
        }
        h += '<td class="' + (t2 === cur ? 'now-col' : '') + cls + '">' + txt + '</td>';
      }
      h += '</tr>';
    });
    $('pipe').innerHTML = h;
    $('legend').innerHTML = res.stages.map(function (n) { return '<span><i class="s-' + n + '"></i>' + n + '</span>'; }).join('') +
      '<span><i style="background:var(--warn-soft);outline:1.5px dashed var(--warn)"></i>stage name with * = instruction is stalled here</span>' +
      '<span><i style="background:var(--line)"></i>wait = fetch held until branch outcome known</span><span><i style="background:var(--bad-soft)"></i>flush = wrong-path fetch thrown away</span>';
  }

  function renderNow() {
    var h = '<tr><th>Stage</th><th>Instruction</th></tr>';
    res.stages.forEach(function (name, s) {
      var who = '<span class="muted">empty (bubble)</span>';
      if (cur > 0) {
        for (var i = 0; i < instrs.length; i++) {
          if (res.c[i][s] <= cur && cur < res.c[i][s + 1]) {
            who = '<span class="muted">I' + (i + 1) + '</span> <span class="mono">' + instrs[i].text + '</span>' + (cur > res.c[i][s] ? ' <span class="pill warn">stalled</span>' : '');
            break;
          }
        }
      } else who = '<span class="muted">-</span>';
      h += '<tr><td><span class="pill info">' + name + '</span></td><td>' + who + '</td></tr>';
    });
    $('now').innerHTML = h;
  }

  function renderEvents() {
    var ev = res.events.slice().sort(function (a, b) { return a.i - b.i; });
    var bad = ev.filter(function (e) { return !e.ok; }), ok = ev.filter(function (e) { return e.ok; });
    var h = '';
    if (!bad.length) h += '<div class="ev"><span class="pill good">no stalls</span> This program runs at full pipeline speed with these settings.</div>';
    bad.forEach(function (e) { h += '<div class="ev"><span class="pill ' + (e.type === 'data' ? 'bad' : e.type === 'control' ? 'warn' : 'purple') + '">' + { data: 'data hazard', control: 'control hazard', structural: 'structural hazard' }[e.type] + '</span> ' + e.msg + '</div>'; });
    if (ok.length) {
      h += '<div class="note" style="margin-top:8px">Dependencies that did <b>not</b> cost anything:</div>';
      ok.forEach(function (e) { h += '<div class="ev note">' + e.msg + '</div>'; });
    }
    $('events').innerHTML = h;
  }

  function init() {
    var sel = $('sample');
    Object.keys(P.SAMPLES).forEach(function (k) { var o = document.createElement('option'); o.textContent = k; sel.appendChild(o); });
    $('src').value = P.SAMPLES[sel.value];
    sel.onchange = function () { $('src').value = P.SAMPLES[sel.value]; simulate(false); };
    ['stages', 'branch', 'fwd', 'struct'].forEach(function (id) { $(id).onchange = function () { simulate(true); }; });
    $('btnRun').onclick = function () { simulate(false); };
    $('btnNext').onclick = function () { stop(); if (cur < res.stats.total) { cur++; render(); } };
    $('btnPrev').onclick = function () { stop(); if (cur > 0) { cur--; render(); } };
    $('btnAll').onclick = function () { stop(); cur = res.stats.total; render(); };
    $('btnReset').onclick = function () { stop(); cur = 0; render(); };
    $('btnPlay').onclick = function () {
      if (timer) { stop(); return; }
      if (cur >= res.stats.total) cur = 0;
      $('btnPlay').textContent = 'Pause';
      timer = setInterval(function () { if (cur < res.stats.total) { cur++; render(); } if (cur >= res.stats.total) stop(); }, 700);
    };
    simulate(false);
  }
  init();
})();
