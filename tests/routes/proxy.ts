import { api } from './lib/api';

export const proxy = api.proxy;

export const config = { matcher: '/api/:path*' };
