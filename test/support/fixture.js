/**
 * 测试夹具：刻意构造“同名参数不同含义”的多挂载点树：
 *
 *   主机 :tenant.api.example / api.example / static.example
 *   /v1/orgs/:orgId/users/:id      orgId -> uuid, id -> int
 *   /v2/users/:id                  id -> slug
 *   /admin/users/:id（仅内网主机） id -> int + min(1)
 *   /files/*path                   splat
 *
 * 这样 :id 在三个挂载点下同名但解码规则/含义不同，用来证明分层隔离。
 */
export function buildMultiTenantTree() {
  return {
    apps: [
      {
        id: 'public-api',
        hosts: ['api.example.com', ':tenant.api.example.com'],
        paramRules: [{ name: 'tenant', type: 'slug' }],
        mounts: [
          {
            id: 'v1',
            path: '/v1',
            routes: [
              {
                id: 'v1-user',
                path: '/orgs/:orgId/users/:id',
                methods: ['GET'],
                handler: 'user.v1',
                paramRules: [
                  { name: 'orgId', type: 'uuid' },
                  { name: 'id', type: 'int', min: 1 }
                ]
              },
              {
                id: 'v1-user-post',
                path: '/orgs/:orgId/users/:id',
                methods: ['POST'],
                handler: 'user.v1.post',
                paramRules: [
                  { name: 'orgId', type: 'uuid' },
                  { name: 'id', type: 'int', min: 1 }
                ]
              }
            ]
          },
          {
            id: 'v2',
            path: '/v2',
            routes: [
              {
                id: 'v2-user',
                path: '/users/:id',
                methods: ['GET', 'HEAD'],
                handler: 'user.v2',
                paramRules: [{ name: 'id', type: 'slug' }]
              },
              {
                id: 'v2-users-tail',
                path: '/users/',
                methods: ['GET'],
                handler: 'users.collection'
              }
            ]
          },
          {
            id: 'files',
            path: '/files/*path',
            routes: [
              {
                id: 'file-get',
                path: '/download',
                methods: ['GET'],
                handler: 'file.download',
                paramRules: []
              }
            ]
          }
        ]
      },
      {
        id: 'admin-api',
        hosts: ['admin.internal.example.com'],
        mounts: [
          {
            id: 'admin-root',
            path: '/admin',
            routes: [
              {
                id: 'admin-user',
                path: '/users/:id',
                methods: ['GET', 'DELETE'],
                handler: 'admin.user',
                paramRules: [{ name: 'id', type: 'int', min: 1 }]
              }
            ]
          }
        ]
      }
    ]
  };
}

/** 注册一组带拒绝行为的处理器。 */
export function registerFixtureHandlers(workbench, { rejectId } = {}) {
  workbench.registerHandler('user.v1', ({ params }) => ({
    ok: true,
    body: { layer: 'v1', orgId: params.resource.orgId, id: params.resource.id, tenant: params.app.tenant }
  }));
  workbench.registerHandler('user.v1.post', () => ({ ok: true, status: 201, body: { created: true } }));
  workbench.registerHandler('user.v2', ({ params }) => ({
    ok: true,
    body: { layer: 'v2', id: params.resource.id }
  }));
  workbench.registerHandler('users.collection', () => ({ ok: true, body: { collection: true } }));
  workbench.registerHandler('file.download', ({ params }) => ({
    ok: true,
    body: { path: params.mount.path }
  }));
  workbench.registerHandler('admin.user', ({ params }) => {
    if (rejectId && String(params.resource.id) === String(rejectId)) {
      return { ok: false, status: 403, code: 'FORBIDDEN_BY_HANDLER', message: '处理器内部拒绝：资源被冻结', detail: { id: params.resource.id } };
    }
    return { ok: true, body: { admin: true, id: params.resource.id } };
  });
}

/** FIFO 总线下把一次解释跑到底。 */
export async function resolveFresh(workbench, request, opts = {}) {
  return workbench.resolve(request, opts);
}
