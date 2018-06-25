Package.describe({
    summary: 'A reactive store with deep dependency tracking for meteor.',
    version: '1.0.0',
    name: 'jmaric:deep-reactive-store',
    documentation: 'README.md',
    git: 'https://github.com/jeffm24/meteor-reactive-store.git'
});

Package.onUse((api) => {
    api.use(['tracker', 'ecmascript']);
    api.mainModule('reactive_store.js');
});

Package.onTest((api) => {
    api.use(['tracker', 'ecmascript', 'reactive-dict', 'meteortesting:mocha']);
    api.use('jmaric:deep-reactive-store');
    
    api.mainModule('reactive_store.tests.js');
});
