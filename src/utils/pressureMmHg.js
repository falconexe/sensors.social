/** Map charts and markers expect mmHg. Firmware JSON is Pascal (sometimes labeled hPa). */

const PA_TO_MMHG = 1 / 133.322387415;
const PASCAL_THRESHOLD = 3000;
const PASCAL_TIMES_100_THRESHOLD = 200000;

export function pressureToMmHg(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return value;
  // Some Urban builds stored Pa, labeled hPa, then *100 for proto pascal.
  if (n > PASCAL_TIMES_100_THRESHOLD) n /= 100;
  if (n >= PASCAL_THRESHOLD) n *= PA_TO_MMHG;
  return +n.toFixed(3);
}
