export default {
  plugins: [],
  main: {
    build: {
      rollupOptions: {
        external: ["electron", "better-sqlite3"]
      }
    }
  },
  preload: {},
  renderer: {}
};
