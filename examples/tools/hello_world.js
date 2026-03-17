// BeerCan Custom Tool Example: hello_world
// This is a minimal example showing how to create a custom tool.
// Drop .js files in ~/.beercan/tools/ and they're auto-loaded on startup.

export const definition = {
  name: "hello_world",
  description: "A simple example tool that echoes back a greeting. Use this as a template for your own tools.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name to greet",
      },
    },
    required: ["name"],
  },
};

export async function handler({ name }) {
  return `Hello, ${name}! This is a custom BeerCan tool. Modify this handler to do anything you need.`;
}
