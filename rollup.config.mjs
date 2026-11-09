import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import esmShim from '@rollup/plugin-esm-shim';
import replace from '@rollup/plugin-replace';

const external = (id) => {
  return !/^[./]/.test(id);
};

const bundle = (config) => ({
  ...config,
  input: 'src/index.ts',
  external,
});

export default [
  bundle({
    plugins: [
      esmShim(),
      esbuild(),
    ],
    output: [
      {
        dir: 'dist/esm',
        format: 'es',
        exports: 'named',
        sourcemap: true,
        entryFileNames: '[name].mjs',
        preserveModules: true,
      },
      {
        dir: 'dist/cjs',
        format: 'cjs',
        exports: 'named',
        sourcemap: true,
        entryFileNames: '[name].cjs',
        preserveModules: true,
      },
    ],
  }),
  {
    plugins: [dts()],
    input: 'src/index.ts',
    external,
    output: {
      dir: 'dist/types/lib',
      format: 'cjs',
      exports: 'named',
      preserveModules: true,
    },
  },
];