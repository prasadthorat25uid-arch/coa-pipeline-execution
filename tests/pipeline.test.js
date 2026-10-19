// Run with:  node tests/pipeline.test.js
const assert = require('assert');
const P = require('../pipeline.js');

const run = (src, cfg) => {
  const p = P.parse(src);
  assert.deepStrictEqual(p.errors, [], p.errors.join('; '));
  return P.schedule(p.instrs, Object.assign({ stages: 5, forwarding: false, branch: 'stall', structural: false }, cfg));
};

// no hazards: N + S - 1 cycles, CPI approaches 1
let r = run(P.SAMPLES['Independent instructions (no hazards)']);
assert.strictEqual(r.stats.total, 5 + 5 - 1);
assert.strictEqual(r.stats.stalls, 0);

// textbook RAW: back-to-back dependency, no forwarding -> 2 stall cycles on a 5-stage pipe
r = run('ADD R1, R2, R3\nSUB R4, R1, R5');
assert.strictEqual(r.stats.total, 8);
assert.strictEqual(r.totals.data, 2);
// cell check: second instruction sits in ID for cycles 3,4,5
assert.deepStrictEqual(r.cells[1].slice(0, 8).map(c => c && (c.stage + (c.stall ? '*' : ''))), [null, 'IF', 'ID', 'ID*', 'ID*', 'EX', 'MEM', 'WB']);

// distance 2 dependency -> 1 stall; distance 3 -> none (write first half, read second half)
assert.strictEqual(run('ADD R1, R2, R3\nNOP\nSUB R4, R1, R5').totals.data, 1);
assert.strictEqual(run('ADD R1, R2, R3\nNOP\nNOP\nSUB R4, R1, R5').totals.data, 0);

// forwarding removes ALU-use stalls
r = run('ADD R1, R2, R3\nSUB R4, R1, R5\nAND R6, R1, R4', { forwarding: true });
assert.strictEqual(r.stats.total, 7);
assert.strictEqual(r.totals.data, 0);

// ...but a load followed by its user still stalls once (load-use)
r = run('LW R1, 0(R2)\nADD R3, R1, R4', { forwarding: true });
assert.strictEqual(r.stats.total, 7);
assert.strictEqual(r.totals.data, 1);

// store data only needed in MEM, so LW then SW of the same register does not stall with forwarding
r = run('LW R1, 0(R2)\nSW R1, 4(R2)', { forwarding: true });
assert.strictEqual(r.totals.data, 0);
assert.strictEqual(r.stats.total, 6);

// control: stall policy always loses 2 cycles per branch on 5 stages
r = run('BEQ R1, R2, NT\nADD R3, R4, R5', { branch: 'stall' });
assert.strictEqual(r.totals.control, 2);
// predict-not-taken: free when not taken, 2 cycles when taken
assert.strictEqual(run('BEQ R1, R2, NT\nADD R3, R4, R5', { branch: 'predict' }).totals.control, 0);
assert.strictEqual(run('BEQ R1, R2, T\nADD R3, R4, R5', { branch: 'predict' }).totals.control, 2);

// structural hazard with a single memory port: the 4th instruction's fetch collides with the LW's MEM
r = run('LW R1, 0(R2)\nADD R3, R4, R5\nADD R6, R7, R8\nADD R9, R10, R11', { structural: true });
assert.strictEqual(r.totals.structural, 1);
assert.strictEqual(r.stats.total, 9);

// other pipeline depths
r = run('ADD R1, R2, R3\nSUB R4, R1, R5', { stages: 4 });
assert.strictEqual(r.stats.total, 6);      // 5 ideal + 1 stall
r = run('ADD R1, R2, R3\nSUB R4, R1, R5', { stages: 3 });
assert.strictEqual(r.stats.total, 4);      // 3 stages: result is written in EX (cycle 3) and read in ID of the next instruction in that same cycle, so no stall

// the cycle count must always equal ideal + stall cycles, whatever the program or settings
let seed = 99;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const reg = () => 'R' + rnd(6);                       // few registers -> lots of dependencies
const makers = [
  () => `ADD ${reg()}, ${reg()}, ${reg()}`,
  () => `SUB ${reg()}, ${reg()}, ${reg()}`,
  () => `LW ${reg()}, ${rnd(8) * 4}(${reg()})`,
  () => `SW ${reg()}, ${rnd(8) * 4}(${reg()})`,
  () => `BEQ ${reg()}, ${reg()}, ${rnd(2) ? 'T' : 'NT'}`,
  () => 'NOP'
];
let checked = 0;
for (let trial = 0; trial < 300; trial++) {
  const len = 1 + rnd(14);
  const src = Array.from({ length: len }, () => makers[rnd(makers.length)]()).join('\n');
  for (const stages of [3, 4, 5]) for (const forwarding of [false, true]) for (const branch of ['stall', 'predict']) for (const structural of [false, true]) {
    const res = run(src, { stages, forwarding, branch, structural });
    assert.strictEqual(res.stats.total, res.stats.ideal + res.stats.stalls, `mismatch for ${JSON.stringify({ stages, forwarding, branch, structural })}\n${src}`);
    // forwarding never makes things slower
    if (!structural) {
      const slow = run(src, { stages, forwarding: false, branch, structural });
      const fast = run(src, { stages, forwarding: true, branch, structural });
      assert.ok(fast.stats.total <= slow.stats.total);
    }
    // each stage is entered strictly after the previous one, and in program order
    for (let i = 0; i < res.c.length; i++) {
      for (let s = 1; s <= stages; s++) assert.ok(res.c[i][s] > res.c[i][s - 1]);
      if (i) for (let s = 0; s < stages; s++) assert.ok(res.c[i][s] > res.c[i - 1][s], 'instructions overtook each other');
    }
    checked++;
  }
}

// parser behaviour
assert.strictEqual(P.parse('FOO R1').errors.length, 1);
assert.strictEqual(P.parse('ADD R1, R2').errors.length, 1);
assert.strictEqual(P.parse('LW R1, R2').errors.length, 1);
assert.strictEqual(P.parse('ADD R1, R2, R40').errors.length, 1);
assert.strictEqual(P.parse('# only a comment\n\nNOP').instrs.length, 1);
// R0 never causes a hazard
assert.strictEqual(run('ADD R0, R2, R3\nSUB R4, R0, R5').totals.data, 0);

console.log('pipeline.test.js: all checks passed (' + checked + ' random configurations verified)');
