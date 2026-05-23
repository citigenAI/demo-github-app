import QRCode from 'qrcode';

export async function generateContributorQr(contributorUrl: string): Promise<string> {
  return QRCode.toDataURL(contributorUrl, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  });
}
