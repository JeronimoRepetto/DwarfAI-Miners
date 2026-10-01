const module = { exports: {} }
process.dlopen(module, 'canary.node')
export default module
