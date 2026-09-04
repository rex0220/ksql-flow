declare module "encoding-japanese" {
  type EncodingName = "SJIS" | "UNICODE" | "UTF8" | "EUCJP" | "JIS" | "AUTO";
  interface ConvertOptions {
    to: EncodingName;
    from?: EncodingName;
    type?: "array";
  }
  const Encoding: {
    stringToCode(text: string): number[];
    convert(data: number[] | Uint8Array, options: ConvertOptions): number[];
  };
  export default Encoding;
}
