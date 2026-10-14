import { AsyncLocalStorage } from 'node:async_hooks';

// Compatibility bridge for existing leaf APIs. The context itself is captured
// at the HTTP/service boundary and passed explicitly to execution and tools.
const scope = new AsyncLocalStorage();
export const currentRequestContext = () => scope.getStore();
export const requestEnvironment = () => scope.getStore()?.env || process.env;
export const runWithRequestContext = (context, work) => scope.run(context, work);
