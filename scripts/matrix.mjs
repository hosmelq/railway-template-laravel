import { combinations, variant, variants } from './lib.mjs';

const selected = process.argv[2] ? [variant(process.argv[2])] : variants;
console.log(JSON.stringify({
  variants: { include: selected.map(({ id }) => ({ variant: id })) },
  tests: { include: selected.flatMap(({ id }) => combinations().map((entry) => ({ variant: id, ...entry }))) },
}));
