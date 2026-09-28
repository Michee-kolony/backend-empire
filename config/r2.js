const { S3Client } = require('@aws-sdk/client-s3');

// Identifiants Cloudflare R2
const R2_ACCOUNT_ID = '75fdb20f0e6a0ac6591025a64b863028'; // à remplacer : ID du compte Cloudflare (tableau de bord R2)
const R2_BUCKET = 'empire'; // à remplacer : nom du bucket
const R2_PUBLIC_URL = 'https://pub-d3cc0efda42a4e418d2fc45c96727dff.r2.dev';

// Client S3 compatible R2
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: '78be3ffc0b30a405841d0600e0ec6f23',
        secretAccessKey: 'ba134f9010ca1b57cd2f32a07c7ed06b8661261344f1deb30534db38d25fe13b'
    },
});

module.exports = { r2, R2_BUCKET, R2_PUBLIC_URL };
