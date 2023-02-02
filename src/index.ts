import { Readable } from 'node:stream';
import { parse } from 'node:url';
import type { WithRequired } from '@apollo/utils.withrequired';
import type { HTTPGraphQLResponseBody } from '@apollo/server/dist/esm/externalTypes/http';
import type {
  ApolloServer,
  BaseContext,
  ContextFunction,
  HTTPGraphQLRequest,
} from '@apollo/server';
import type Koa from 'koa';
// we need the extended `Request` type from `koa-bodyparser`,
// this is similar to an effectful import but for types, since
// the `koa-bodyparser` types "polyfill" the `koa` types
import type * as _ from 'koa-bodyparser';

export interface KoaContextFunctionArgument {
  ctx: Koa.Context;
}

interface KoaMiddlewareOptions<TContext extends BaseContext> {
  context?: ContextFunction<[KoaContextFunctionArgument], TContext>;
}

export function koaMiddleware(
  server: ApolloServer<BaseContext>,
  options?: KoaMiddlewareOptions<BaseContext>,
): Koa.Middleware;
export function koaMiddleware<TContext extends BaseContext>(
  server: ApolloServer<TContext>,
  options: WithRequired<KoaMiddlewareOptions<TContext>, 'context'>,
): Koa.Middleware;
export function koaMiddleware<TContext extends BaseContext>(
  server: ApolloServer<TContext>,
  options?: KoaMiddlewareOptions<TContext>,
): Koa.Middleware {
  server.assertStarted('koaMiddleware()');

  // This `any` is safe because the overload above shows that context can
  // only be left out if you're using BaseContext as your context, and {} is a
  // valid BaseContext.
  const defaultContext: ContextFunction<
    [KoaContextFunctionArgument],
    any
  > = async () => ({});

  const context: ContextFunction<[KoaContextFunctionArgument], TContext> =
    options?.context ?? defaultContext;

  return async ctx => {
    if (!ctx.request.body) {
      // The json koa-bodyparser *always* sets ctx.request.body to {} if it's unset (even
      // if the Content-Type doesn't match), so if it isn't set, you probably
      // forgot to set up koa-bodyparser.
      ctx.status = 500;
      ctx.body =
        '`ctx.request.body` is not set; this probably means you forgot to set up the ' +
        '`koa-bodyparser` middleware before the Apollo Server middleware.';
      return;
    }

    const incomingHeaders = new Map(function*() {
      for (const [ key, value ] of Object.entries(ctx.headers)) {
        if (value !== undefined) {
          // Node/Koa headers can be an array or a single value. We join
          // multi-valued headers with `, ` just like the Fetch API's `Headers`
          // does. We assume that keys are already lower-cased (as per the Node
          // docs on IncomingMessage.headers) and so we don't bother to lower-case
          // them or combine across multiple keys that would lower-case to the
          // same value.
          yield [
            key,
            Array.isArray(value) ? value.join(', ') : value,
          ];
        }
      }
    }());

    const httpGraphQLRequest: HTTPGraphQLRequest = {
      method: ctx.method.toUpperCase(),
      headers: incomingHeaders,
      search: parse(ctx.url).search ?? '',
      body: ctx.request.body,
    };

    const { body, headers, status } = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest,
      context: () => context({ ctx }),
    });

    if (body.kind === 'complete') {
      ctx.body = body.string;
    } else if (body.kind === 'chunked') {
      ctx.body = Readable.from(async function*() {
        for await (const chunk of body.asyncIterator) {
          yield chunk;
          if (typeof ctx.body.flush === "function") {
            // If this response has been piped to a writable compression stream then `flush` after
            // each chunk.
            // This is identical to the Express integration:
            // https://github.com/apollographql/apollo-server/blob/a69580565dadad69de701da84092e89d0fddfa00/packages/server/src/express4/index.ts#L96-L105
            ctx.body.flush();
          }
        }
      }());
    } else {
      throw Error(`Delivery method ${(body as HTTPGraphQLResponseBody).kind} not implemented`);
    }

    if (status !== undefined) {
      ctx.status = status;
    }
    for (const [key, value] of headers) {
      ctx.set(key, value);
    }
  };
}
