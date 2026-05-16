import base from "eslint-config-next";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier/flat";
import typeScript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", "coverage/**", "node_modules/**"],
  },
  ...base,
  ...coreWebVitals,
  ...typeScript,
  prettier,
];

export default eslintConfig;
