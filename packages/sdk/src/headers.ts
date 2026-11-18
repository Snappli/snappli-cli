/** `Headers` de fetch, `req.headers` de Node/Express o un objeto simple (cualquier mayúscula). */
export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<readonly [string, string]>;

/** Valor de una cabecera sin importar mayúsculas; el primero si viene repetida. */
export function getHeader(headers: HeadersLike, name: string): string | undefined {
  const wanted = name.toLowerCase();
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(wanted) ?? undefined;
  }
  if (Symbol.iterator in headers) {
    for (const [key, value] of headers as Iterable<readonly [string, string]>) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
