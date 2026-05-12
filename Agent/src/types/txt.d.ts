// TypeScript declaration for importing .txt files as strings
declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "@eval/machine_eval/query_round3.txt" {
  const content: string;
  export default content;
}
