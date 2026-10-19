/*
 * pipeline.js - core of the pipeline execution simulator (no DOM code).
 *
 * The simulator takes a straight-line TRACE of instructions (the instructions in the order the
 * CPU actually executes them; a branch is marked T for taken or NT for not taken) and works out
 * in which clock cycle each instruction enters each pipeline stage.
 *
 * Rules used (classic in-order pipeline, register file written in the first half of a cycle and
 * read in the second half, so a value written in WB can be read in ID of the same cycle):
 *   - an instruction moves forward only when the next stage has been left by the one ahead of it
 *   - without forwarding an instruction waits in ID until its source registers have been written back
 *   - with forwarding the value is passed on as soon as it exists: after EX for ALU results,
 *     after MEM for loads (so a load followed by a user of the loaded value still costs 1 cycle)
 *   - a store needs the register it stores only when it reaches MEM
 *   - a branch is resolved at the end of EX
 *   - optional structural hazard: one memory port shared by instruction fetch and data access
 */
(function (root) {
  'use strict';

  var STAGE_SETS = {
    5: { names: ['IF', 'ID', 'EX', 'MEM', 'WB'], ex: 2, mem: 3, wb: 4 },
    4: { names: ['IF', 'ID', 'EX', 'WB'],        ex: 2, mem: 2, wb: 3 },   // memory access folded into EX
    3: { names: ['IF', 'ID', 'EX'],              ex: 2, mem: 2, wb: 2 }    // EX also does memory access and write back
  };

  /* ------------------------------------------------------------- parser */
  var ALU3 = { ADD: 1, SUB: 1, AND: 1, OR: 1, SLT: 1 };

  function parseReg(tok) {
    var m = /^R(\d{1,2})$/i.exec(tok || '');
    if (!m || Number(m[1]) > 31) return null;
    return Number(m[1]);
  }

  function parse(text) {
    var out = [], errors = [];
    text.split(/\r?\n/).forEach(function (raw, ln) {
      var line = raw.replace(/[;#].*$/, '').trim();
      if (!line) return;
      var m = /^([A-Za-z]+)\s*(.*)$/.exec(line);
      var op = m[1].toUpperCase(), rest = m[2].trim();
      var args = rest ? rest.split(/[\s,]+/).filter(Boolean) : [];
      var ins = { text: line.replace(/\s+/g, ' '), op: op, dest: null, srcs: [], storeSrc: null, isLoad: false, isStore: false, isBranch: false, taken: false };
      function bad(msg) { errors.push('Line ' + (ln + 1) + ': ' + msg); }

      if (ALU3[op]) {
        var d = parseReg(args[0]), a = parseReg(args[1]), b = parseReg(args[2]);
        if (args.length !== 3 || d === null || a === null || b === null) { bad(op + ' needs three registers, e.g. ' + op + ' R1, R2, R3'); return; }
        ins.dest = d; ins.srcs = [a, b];
      } else if (op === 'ADDI') {
        var d2 = parseReg(args[0]), a2 = parseReg(args[1]);
        if (args.length !== 3 || d2 === null || a2 === null || isNaN(Number(args[2]))) { bad('ADDI needs: ADDI R1, R2, 5'); return; }
        ins.dest = d2; ins.srcs = [a2];
      } else if (op === 'LW' || op === 'SW') {
        var mm = /^(R\d{1,2})[\s,]+(-?\d+)\s*\(\s*(R\d{1,2})\s*\)$/i.exec(rest);
        var rt = mm ? parseReg(mm[1]) : null, rs = mm ? parseReg(mm[3]) : null;
        if (!mm || rt === null || rs === null) { bad(op + ' needs: ' + op + ' R1, 0(R2)'); return; }
        if (op === 'LW') { ins.dest = rt; ins.srcs = [rs]; ins.isLoad = true; }
        else { ins.srcs = [rs]; ins.storeSrc = rt; ins.isStore = true; }
      } else if (op === 'BEQ' || op === 'BNE') {
        var r1 = parseReg(args[0]), r2 = parseReg(args[1]), flag = (args[2] || 'NT').toUpperCase();
        if (r1 === null || r2 === null || args.length < 2 || args.length > 3 || (flag !== 'T' && flag !== 'NT')) { bad(op + ' needs: ' + op + ' R1, R2, T   (or NT for not taken)'); return; }
        ins.srcs = [r1, r2]; ins.isBranch = true; ins.taken = flag === 'T';
        ins.text = op + ' R' + r1 + ', R' + r2 + ', ' + flag;
      } else if (op === 'NOP') {
        if (args.length) { bad('NOP takes no operands'); return; }
      } else {
        bad('unknown instruction "' + m[1] + '". Use ADD SUB AND OR SLT ADDI LW SW BEQ BNE NOP.');
        return;
      }
      // register R0 is always zero: it never creates a dependency
      if (ins.dest === 0) ins.dest = null;
      ins.srcs = ins.srcs.filter(function (r) { return r !== 0; });
      if (ins.storeSrc === 0) ins.storeSrc = null;
      out.push(ins);
    });
    return { instrs: out, errors: errors };
  }

  /* ----------------------------------------------------------- scheduler */
  /*
   * cfg: { stages: 3|4|5, forwarding: bool, branch: 'stall'|'predict', structural: bool }
   */
  function schedule(instrs, cfg) {
    var D = STAGE_SETS[cfg.stages];
    var S = D.names.length, n = instrs.length;
    var c = [];                       // c[i][s] = cycle in which instruction i enters stage s; c[i][S] = cycle it leaves the pipeline
    var info = [];                    // per-instruction extras for display
    var events = [];
    var totals = { data: 0, control: 0, structural: 0 };

    for (var i = 0; i < n; i++) {
      var ins = instrs[i], row = new Array(S + 1), ex = { flush: null, notes: [] };
      var prev = i > 0 ? c[i - 1] : null;

      // find the latest earlier writer of each source register
      var deps = [];
      function producerOf(reg) {
        for (var j = i - 1; j >= 0; j--) if (instrs[j].dest === reg) return j;
        return -1;
      }
      ins.srcs.forEach(function (r) { var p = producerOf(r); if (p >= 0) deps.push({ reg: r, p: p, isStoreData: false }); });
      if (ins.storeSrc !== null) { var ps = producerOf(ins.storeSrc); if (ps >= 0) deps.push({ reg: ins.storeSrc, p: ps, isStoreData: true }); }
      var depStall = deps.map(function () { return 0; });

      for (var s = 0; s < S; s++) {
        var lo = s === 0 ? 1 : row[s - 1] + 1;
        if (prev) lo = Math.max(lo, prev[s + 1]);          // the instruction ahead must have left this stage

        if (s === 0) {
          // control hazard from the instruction just before
          if (i > 0 && instrs[i - 1].isBranch && (cfg.branch === 'stall' || instrs[i - 1].taken)) {
            var resume = prev[D.ex + 1];                    // cycle after the branch finished EX
            if (resume > lo) {
              // cycles the branch itself spent waiting for its operands are already counted as data stalls
              var extra = prev[D.ex] - prev[1] - (D.ex - 1);
              var lost = resume - lo - extra;
              ex.flush = { from: lo, to: resume - 1, kind: cfg.branch === 'stall' ? 'bubble' : 'flush' };
              if (lost > 0) {
                totals.control += lost;
                events.push({ type: 'control', i: i, msg: 'I' + (i + 1) + ' (' + ins.text + ') could not be fetched until the branch I' + i + ' finished EX: ' + lost + ' cycle' + (lost > 1 ? 's' : '') + ' lost' +
                  (cfg.branch === 'stall' ? ' (pipeline waits for the branch outcome).' : ' (branch was taken, so the instruction(s) fetched after it were wrong and are flushed).') });
              }
              lo = resume;
            }
          } else if (i > 0 && instrs[i - 1].isBranch && cfg.branch === 'predict') {
            events.push({ type: 'control', i: i, msg: 'I' + i + ' is a branch that was NOT taken, so predict-not-taken guessed right: no penalty.', ok: true });
          }
        }

        // data hazards
        if (deps.length) {
          deps.forEach(function (d, k) {
            var needStage, avail;
            if (cfg.forwarding) {
              needStage = d.isStoreData ? D.mem : D.ex;
              var res = instrs[d.p].isLoad ? D.mem : D.ex;
              avail = c[d.p][res + 1];
            } else {
              needStage = D.ex;
              avail = c[d.p][D.wb] + 1;
            }
            if (s === needStage) {
              var before = lo;
              if (avail > lo) { depStall[k] = avail - before; lo = avail; }
            }
          });
        }

        // structural hazard: instruction fetch and data access share one memory port
        if (cfg.structural && s === 1) {
          var clash = true, moved = 0;
          while (clash) {
            clash = false;
            var fetchCycle = lo - 1;
            for (var j = 0; j < i; j++) {
              if ((instrs[j].isLoad || instrs[j].isStore) && c[j][D.mem + 1] !== undefined &&
                  fetchCycle >= c[j][D.mem] && fetchCycle < c[j][D.mem + 1]) { clash = true; ex.structHit = j; break; }
            }
            if (clash) { lo++; moved++; }
          }
          if (moved) {
            totals.structural += moved;
            events.push({ type: 'structural', i: i, msg: 'I' + (i + 1) + ' (' + ins.text + ') wanted to be fetched while I' + (ex.structHit + 1) + ' used the single memory port: ' + moved + ' cycle' + (moved > 1 ? 's' : '') + ' lost.' });
          }
        }
        row[s] = lo;
      }
      row[S] = row[S - 1] + 1;
      c.push(row);

      // record data-hazard events (only for producers that were still in the pipeline)
      deps.forEach(function (d, k) {
        var dist = i - d.p;
        if (dist >= S && depStall[k] === 0) return;
        var pi = 'I' + (d.p + 1), ci = 'I' + (i + 1), r = 'R' + d.reg;
        if (depStall[k] > 0) {
          totals.data += depStall[k];
          events.push({ type: 'data', i: i, msg: ci + ' (' + ins.text + ') needs ' + r + ' from ' + pi + ' (' + instrs[d.p].text + '): ' + depStall[k] + ' stall cycle' + (depStall[k] > 1 ? 's' : '') +
            (cfg.forwarding ? (instrs[d.p].isLoad ? ' even with forwarding, because a load only has its data after MEM (load-use hazard).' : '.')
                             : ' while waiting for ' + pi + ' to write ' + r + ' back in WB.'), stall: depStall[k] });
        } else {
          events.push({ type: 'data', i: i, msg: ci + ' needs ' + r + ' from ' + pi + ': ' + (cfg.forwarding ? 'value forwarded, no stall.' : 'already written back, no stall.'), ok: true });
        }
      });
      info.push(ex);
    }

    var total = n ? c[n - 1][S] - 1 : 0;
    var ideal = n ? n + S - 1 : 0;

    // grid cells: cells[i][t-1] = { stage, stall } | { bubble } | null
    var cells = [];
    for (var a = 0; a < n; a++) {
      var line = [];
      for (var t = 1; t <= total; t++) {
        var cell = null;
        for (var st = 0; st < S; st++) {
          if (c[a][st] <= t && t < c[a][st + 1]) { cell = { stage: D.names[st], stall: t > c[a][st], si: st }; break; }
        }
        if (!cell && info[a].flush && t >= info[a].flush.from && t <= info[a].flush.to) cell = { bubble: info[a].flush.kind, si: -1 };
        line.push(cell);
      }
      cells.push(line);
    }

    var stalls = totals.data + totals.control + totals.structural;
    return {
      stages: D.names, c: c, cells: cells, events: events, totals: totals,
      stats: {
        instructions: n, total: total, ideal: ideal, stalls: stalls,
        cpi: n ? total / n : 0,
        speedup: total ? (n * S) / total : 0,              // versus finishing each instruction before starting the next
        efficiency: total ? ideal / total : 0
      }
    };
  }

  /* ------------------------------------------------------------- samples */
  var SAMPLES = {
    'Independent instructions (no hazards)': [
      'ADD R1, R2, R3', 'SUB R4, R5, R6', 'AND R7, R8, R9', 'OR  R10, R11, R12', 'ADD R13, R14, R15'
    ].join('\n'),
    'Data hazard chain (RAW)': [
      'ADD R1, R2, R3', 'SUB R4, R1, R5', 'AND R6, R1, R7', 'OR  R8, R1, R9', 'ADD R10, R1, R1'
    ].join('\n'),
    'Load-use hazard': [
      'LW  R1, 0(R2)', 'ADD R3, R1, R4', 'SUB R5, R3, R6', 'SW  R5, 4(R7)'
    ].join('\n'),
    'Branch taken, then not taken': [
      'ADD R1, R2, R3', 'BEQ R1, R4, T', 'LW  R5, 0(R6)', 'ADD R7, R5, R8', 'BNE R7, R0, NT', 'SUB R9, R7, R1'
    ].join('\n'),
    'Mixed program': [
      'LW  R1, 0(R2)', 'LW  R3, 4(R2)', 'ADD R4, R1, R3', 'SW  R4, 8(R2)', 'SUB R5, R4, R1', 'BEQ R5, R0, NT', 'ADDI R6, R5, 1', 'AND R7, R6, R4'
    ].join('\n')
  };

  var api = { parse: parse, schedule: schedule, STAGE_SETS: STAGE_SETS, SAMPLES: SAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PipelineSim = api;
})(typeof window !== 'undefined' ? window : this);
