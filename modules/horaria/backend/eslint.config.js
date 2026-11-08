// Una sola regla, i la que ens hauria salvat dues vegades.
//
// Al frontend es va posar `no-undef` després que treure un bloc de codi
// esborrés una variable que altres parts encara feien servir: Vite va compilar
// sense queixar-se i la pantalla d'horaris va quedar en blanc a producció.
//
// Al backend no hi havia res, i el 12 d'agost una auditoria va trobar
// `esSobreLHorari(mensaje, prefs)` a whatsapp.js, on la variable es diu
// `texto`. Portava dies llançant un ReferenceError cada cop que algú escrivia
// alguna cosa fora de tema: la persona es quedava sense resposta i l'error
// només sortia als logs del servidor, que no mira ningú.
//
// Node no avisa d'això fins que la línia s'executa, i aquesta línia només
// s'executa en un camí concret. Els tests no hi passaven.
export default [
  { ignores: ["test/fixtures/**"] },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Response: 'readonly', FormData: 'readonly', Blob: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', crypto: 'readonly', AbortSignal: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', require: 'readonly',
        module: 'writable', exports: 'writable', global: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
];
