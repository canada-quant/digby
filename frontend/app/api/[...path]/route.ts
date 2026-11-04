import { NextRequest } from 'next/server';

// Disable Next.js body parsing for this route — we stream the raw body directly to the backend
// This is critical for multipart/form-data file uploads which break when buffered through arrayBuffer()
export const runtime = 'nodejs';

// API proxy to forward requests to backend
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxyRequest(request, path);
}

async function proxyRequest(request: NextRequest, path: string[]) {
  // Use backend container name in Docker, or localhost outside Docker
  const backendUrl = process.env.BACKEND_URL || 'http://backend:4000';
  const apiPath = path.join('/');
  const url = `${backendUrl}/api/${apiPath}${request.nextUrl.search}`;

  try {
    const headers: HeadersInit = {};
    
    // Forward relevant headers
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      headers['authorization'] = authHeader;
    }

    const contentType = request.headers.get('content-type');
    if (contentType) {
      headers['content-type'] = contentType;
    }

    // Forward content-length (critical for multipart uploads to set correct body size)
    const contentLength = request.headers.get('content-length');
    if (contentLength) {
      headers['content-length'] = contentLength;
    }

    // Forward cookies
    const cookies = request.headers.get('cookie');
    if (cookies) {
      headers['cookie'] = cookies;
    }

    const options: RequestInit = {
      method: request.method,
      headers,
    };

    // Add body for POST/PUT/PATCH requests
    // For multipart/form-data (file uploads): stream the body directly to avoid
    // buffering issues with arrayBuffer() in Next.js App Router.
    // For other content types: use arrayBuffer() which is safe and reliable.
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      if (contentType?.includes('multipart/form-data')) {
        // Stream multipart body directly — avoid buffering binary data through arrayBuffer()
        // @ts-ignore — duplex is required for streaming bodies in Node.js fetch
        options.duplex = 'half';
        options.body = request.body;
      } else {
        // For JSON and other text bodies, arrayBuffer() is fine
        options.body = await request.arrayBuffer();
      }
    }

    const response = await fetch(url, options);
    // SSE / streaming responses (ticket 61d33af9: POST /admin/model-roles/test/stream
    // keepalives a 180 s image probe past the ALB's 60 s idle timeout) must pass
    // through UNBUFFERED — awaiting arrayBuffer() would hold the whole stream
    // (killing the keepalive) and can also blow the buffer on a long stream.
    const upstreamType = response.headers.get('content-type') || '';
    const isEventStream = upstreamType.includes('text/event-stream');

    // Forward response with headers
    const responseHeaders = new Headers();

    // Forward ALL Set-Cookie headers (getSetCookie returns all, get() only returns the first)
    const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
    if (setCookieHeaders.length === 0) {
      const firstCookie = response.headers.get('set-cookie');
      if (firstCookie) setCookieHeaders.push(firstCookie);
    }
    for (const cookie of setCookieHeaders) {
      responseHeaders.append('set-cookie', cookie);
    }

    // Forward content-type
    const responseContentType = response.headers.get('content-type');
    if (responseContentType) {
      responseHeaders.set('content-type', responseContentType);
    }

    // Forward content-disposition (generated-file downloads)
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      responseHeaders.set('content-disposition', contentDisposition);
    }

    // Event-stream responses pass the body through as a ReadableStream: the
    // keepalive frames reach the browser as the backend writes them, and the
    // stream ends when the backend ends it (the terminal result frame).
    if (isEventStream && response.body) {
      responseHeaders.set('cache-control', 'no-cache, no-store, must-revalidate');
      responseHeaders.set('x-accel-buffering', 'no');
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // arrayBuffer, not text(): binary responses (generated-file downloads)
    // must not round-trip through a UTF-8 string — that mangles bytes.
    const data = await response.arrayBuffer();

    return new Response(data, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to connect to backend' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
}
