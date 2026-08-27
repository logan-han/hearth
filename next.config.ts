import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['@neondatabase/serverless'],
  async redirects() {
    // House merged into Home; old bookmarks keep working.
    return [{ source: '/house', destination: '/', permanent: true }]
  },
}

export default nextConfig
