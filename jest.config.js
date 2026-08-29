export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/_verify-sweep/'],
  modulePathIgnorePatterns: ['/_verify-sweep/'],
};
