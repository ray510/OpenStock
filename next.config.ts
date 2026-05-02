import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    devIndicators: false,
    turbopack: {
        root: process.cwd(),
    },
    /* config options here */
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'i.ibb.co',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 's.yimg.com',
                port: '',
                pathname: '/**',
            },
        ],
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    typescript: {
        ignoreBuildErrors: true,
    }
};

export default nextConfig;
