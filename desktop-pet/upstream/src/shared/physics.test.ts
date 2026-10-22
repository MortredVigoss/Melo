/**
 * 抛掷指令的初速换算单元测试 —— 钉住 `POST /throw` 文档里那张表。
 *
 * 为什么单独钉：契约里写死了两件容易被无声改掉的事——
 *   1. **角度方向**：`0` = 正右、**逆时针为正**（屏幕坐标 y 向下，所以 `vy` 取负号）。
 *      搞反了第三方会发现"往上抛"变成了往下砸，而代码本身不会报任何错；
 *   2. **力度锚点**：`power = 1.0` 对应软钳速**前**的 1200 px/s，实际初速约 1021 px/s。
 *      调一下锚点或限速公式，文档里的数字就成假话了。
 *
 * 跑法：node --experimental-strip-types --test src/shared/physics.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_THROW_SPEED, THROW_SPEED_ANCHOR, softClampSpeed, throwVelocity } from './physics.ts';

/** 初速大小（throwVelocity 的模长） */
const speedOf = (angle: number, power: number): number => {
  const v = throwVelocity(angle, power);
  return Math.hypot(v.vx, v.vy);
};

describe('throwVelocity —— 角度方向（0 = 正右，逆时针为正）', () => {
  test('0° 正右：vx > 0 且 vy ≈ 0', () => {
    const v = throwVelocity(0, 1);
    assert.ok(v.vx > 0, 'vx 应为正');
    assert.ok(Math.abs(v.vy) < 1e-9, 'vy 应为 0');
  });

  test('90° 正上：vy < 0（屏幕坐标 y 向下，故取负号）且 vx ≈ 0', () => {
    const v = throwVelocity(90, 1);
    assert.ok(v.vy < 0, '90° 必须是往上抛——vy 为负');
    assert.ok(Math.abs(v.vx) < 1e-9, 'vx 应为 0');
  });

  test('-90° 正下：vy > 0', () => {
    assert.ok(throwVelocity(-90, 1).vy > 0);
  });

  test('180° 正左：vx < 0', () => {
    assert.ok(throwVelocity(180, 1).vx < 0);
  });

  test('任意实数角度都成立（超出 0~360 按周期折算，调用方不必自己归一化）', () => {
    const a = throwVelocity(450, 1);
    const b = throwVelocity(90, 1);
    assert.ok(Math.abs(a.vx - b.vx) < 1e-9 && Math.abs(a.vy - b.vy) < 1e-9, '450° 应等价于 90°');
  });
});

describe('throwVelocity —— 力度锚点与软上限', () => {
  test('power = 1.0 的实际初速 ≈ 1021 px/s（软钳速前是 1200）', () => {
    const speed = speedOf(0, 1);
    assert.ok(Math.abs(speed - 1020.5) < 1, `实际初速应约 1020.5，得到 ${speed}`);
    assert.ok(speed < THROW_SPEED_ANCHOR, '软上限必须真的压低了它——否则文档那张表是错的');
  });

  test('power = 3.0 的实际初速 ≈ 2276 px/s', () => {
    assert.ok(Math.abs(speedOf(0, 3) - 2275.6) < 1);
  });

  test('随 power 单调递增，且恒不超过 MAX_THROW_SPEED', () => {
    let prev = 0;
    for (const p of [0.001, 0.1, 0.5, 1, 2, 3, 5, 10, 100, 1e6]) {
      const s = speedOf(45, p);
      assert.ok(s > prev, `power=${p} 的初速应严格大于更小的 power（单调可区分）`);
      assert.ok(s <= MAX_THROW_SPEED, `power=${p} 的初速不得超过软上限`);
      prev = s;
    }
    assert.ok(speedOf(45, 1e6) > MAX_THROW_SPEED * 0.99, '极大 power 应渐近软上限');
  });

  test('方向与力度解耦：任意角度下模长只由 power 决定', () => {
    const want = speedOf(0, 2);
    for (const angle of [0, 37, 90, -123, 271]) {
      assert.ok(Math.abs(speedOf(angle, 2) - want) < 1e-9, `angle=${angle}`);
    }
  });
});

describe('softClampSpeed —— 抛掷指令与拖拽甩抛共用同一条限速', () => {
  test('非正数 → 0（不产生反向速度）', () => {
    assert.equal(softClampSpeed(0), 0);
    assert.equal(softClampSpeed(-100), 0);
  });

  test('渐近不超过 MAX_THROW_SPEED（极大输入下取等号，不是超过）', () => {
    assert.ok(softClampSpeed(MAX_THROW_SPEED) < MAX_THROW_SPEED);
    // exp(-1000) 在 float64 下下溢成 0，所以这里会**恰好**取到上限——契约是"不超过"，取等合法
    assert.equal(softClampSpeed(MAX_THROW_SPEED * 1000), MAX_THROW_SPEED);
  });
});
