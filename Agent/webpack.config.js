const path = require("path");
const webpack = require("webpack");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const srcDir = path.join(__dirname, "src");

module.exports = {
  mode: "development",
  devtool: "source-map",
  entry: {
    sidebar: path.join(srcDir, "sidebar/index.tsx"),
    options: path.join(srcDir, "options/index.tsx"),
    background: path.join(srcDir, "background/index.ts"),
    content_script: path.join(srcDir, "content/index.ts"),
  },
  output: {
    path: path.join(__dirname, "dist/js"),
    filename: "[name].js",
  },
  optimization: {
    minimize: false,
    splitChunks: {
      name: "vendor",
      chunks(chunk) {
        return chunk.name !== "background";
      },
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules|thirdparty/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    alias: {
      "@eko-ai/eko": path.resolve(__dirname, "./thirdparty/eko-patch/packages/eko-core/dist/index.esm.js"),
      "@eko-ai/eko-extension": path.resolve(__dirname, "./thirdparty/eko-patch/packages/eko-extension/dist/index.esm.js"),
    },
    fallback: {
      // @axiom/core's IntentiaManager imports Node.js modules for server-side
      // file loading / fingerprinting. The extension never calls those code
      // paths, so we stub them out to keep webpack happy.
      crypto: false,
      fs: false,
      "fs/promises": false,
      path: false,
    },
  },
  plugins: [
    // Strip `node:` URI prefix so resolve.fallback can handle the bare names.
    // @axiom/core's compiled JS uses `node:crypto`, `node:fs/promises`, etc.
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, '');
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: "public", to: "../" },
        // Query datasets are no longer bundled - workers pull jobs from resolver server
      ],
      options: {},
    }),
  ],
};
