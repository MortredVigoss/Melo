// The declaration is both the dispatch table and the route inventory.
export function createRouteRegistry(definitions) {
  const exact = new Map(), patterns = [], inventory = [];
  for (const definition of definitions) {
    const { method, auth, handler } = definition;
    if (!['GET','POST','PUT','PATCH','DELETE'].includes(method) || !['local-read','local-write'].includes(auth) || typeof handler !== 'function') throw Error('Invalid route declaration');
    if (method !== 'GET' && auth !== 'local-write') throw Error('Mutating routes require local-write authorization');
    for (const path of definition.paths || [definition.path]) {
      if (!path && !definition.match) throw Error('Route requires a path or matcher');
      if (path) {
        const key = `${method} ${path}`;
        if (exact.has(key)) throw Error(`Duplicate route: ${key}`);
        exact.set(key,definition); inventory.push({method,path,auth});
      } else { patterns.push(definition); inventory.push({method,path:definition.id,auth}); }
    }
  }
  const find = (request,url) => exact.get(`${request.method} ${url.pathname}`) || patterns.find(route=>route.method===request.method&&route.match(url));
  return {
    inventory: Object.freeze(inventory.map(Object.freeze)),
    matches: (request,url) => Boolean(find(request,url)),
    async handle(request,response,url,requireLocalOrigin) {
      const route=find(request,url);
      if(!route)return false;
      if(route.auth==='local-write' && !requireLocalOrigin?.(request,response))return true;
      await route.handler({request,response,url,requireLocalOrigin});
      return true;
    },
  };
}
