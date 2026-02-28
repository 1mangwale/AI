/**
 * Shared image URL resolution utility.
 *
 * Centralizes the duplicated logic for resolving product image URLs
 * from various item data shapes (OpenSearch hits, PHP responses, etc.)
 * into a canonical S3/CDN URL.
 */

/**
 * Resolve a product image URL from item data.
 *
 * Priority: image_full_url → image_fallback_url → image → images[0] → image_url
 *
 * If the resolved value is already a full URL, it is returned as-is.
 * If it is a relative path / filename, it is prefixed with `s3BaseUrl`.
 */
export function resolveImageUrl(
  item: Record<string, any>,
  s3BaseUrl: string,
  debugLogger?: { debug: (msg: string) => void },
): string | undefined {
  // Also check nested _source (OpenSearch hits keep data there)
  const src = item._source || {};
  let imageUrl =
    item.image_full_url ||
    item.image_fallback_url ||
    item.image ||
    item.images?.[0] ||
    item.image_url ||
    item.logo ||           // Store logo
    item.cover_photo ||    // Store cover photo
    src.image_full_url ||
    src.image ||
    src.images?.[0] ||
    src.image_url ||
    src.logo ||
    src.cover_photo;

  if (!imageUrl) {
    debugLogger?.debug(`resolveImageUrl: no image found in keys [image_full_url, image_fallback_url, image, images[0], image_url, logo, cover_photo]`);
    return undefined;
  }

  const sourceField = imageUrl === item.image_full_url ? 'image_full_url'
    : imageUrl === item.image_fallback_url ? 'image_fallback_url'
    : imageUrl === item.image ? 'image'
    : imageUrl === item.images?.[0] ? 'images[0]'
    : imageUrl === item.image_url ? 'image_url'
    : imageUrl === item.logo ? 'logo'
    : imageUrl === item.cover_photo ? 'cover_photo'
    : imageUrl === src.image_full_url ? '_source.image_full_url'
    : imageUrl === src.image ? '_source.image'
    : imageUrl === src.images?.[0] ? '_source.images[0]'
    : imageUrl === src.image_url ? '_source.image_url'
    : imageUrl === src.logo ? '_source.logo'
    : '_source.cover_photo';
  debugLogger?.debug(`resolveImageUrl: resolved from "${sourceField}" → "${imageUrl}"`);

  // If it's a full URL, check if it's pointing to the broken S3 bucket
  // (mangwale.s3.ap-south-1.amazonaws.com returns 403/404) — redirect to CDN
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    const s3Match = imageUrl.match(
      /https?:\/\/(?:mangwale\.s3[^/]*|s3[^/]*\/mangwale)\/product\/(.+)/
    );
    if (s3Match) {
      // Replace broken S3 URL with the configured CDN (MinIO or otherwise)
      return `${s3BaseUrl}/${s3Match[1]}`;
    }
    // Non-S3 full URL — return as-is
    return imageUrl;
  }

  // Strip leading path prefixes to get the bare filename
  let filename = imageUrl;
  if (filename.startsWith('/product/')) {
    filename = filename.replace('/product/', '');
  } else if (filename.startsWith('product/')) {
    filename = filename.replace('product/', '');
  } else if (filename.startsWith('/store/')) {
    // Store images — use store/ prefix instead of product/
    filename = filename.replace('/store/', '');
    return `${s3BaseUrl.replace('/product', '/store')}/${filename}`;
  } else if (filename.startsWith('store/')) {
    filename = filename.replace('store/', '');
    return `${s3BaseUrl.replace('/product', '/store')}/${filename}`;
  }

  return `${s3BaseUrl}/${filename}`;
}
