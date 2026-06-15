import { config } from '@/config';
export type MediaTypeKey = 'VIDEO' | 'VOICE' | 'PHOTO';

export const MEDIA_ALLOWLIST: Record<
  MediaTypeKey,
  { contentTypes: string[]; extensions: string[] }
> = {
  VIDEO: {
    contentTypes: ['video/mp4', 'video/quicktime'],
    extensions: ['mp4', 'mov'],
  },
  VOICE: {
    contentTypes: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a'],
    extensions: ['mp3', 'm4a'],
  },
  PHOTO: {
    contentTypes: ['image/jpeg', 'image/png'],
    extensions: ['jpg', 'jpeg', 'png'],
  },
};

export function sizeLimitFor(type: MediaTypeKey): number {
  switch (type) {
    case 'VIDEO':
      return config.media.maxVideoBytes;
    case 'VOICE':
      return config.media.maxVoiceBytes;
    case 'PHOTO':
      return config.media.maxPhotoBytes;
  }
}

export function detectMediaTypeFromMime(mime: string): MediaTypeKey | null {
  for (const key of Object.keys(MEDIA_ALLOWLIST) as MediaTypeKey[]) {
    if (MEDIA_ALLOWLIST[key].contentTypes.includes(mime)) return key;
  }
  return null;
}

export function isMediaTypeAllowed(type: MediaTypeKey, mimeType: string): boolean {
  return MEDIA_ALLOWLIST[type].contentTypes.includes(mimeType);
}
