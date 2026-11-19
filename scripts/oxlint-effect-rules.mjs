// Oxlint has no generic no-restricted-syntax rule. Keep the same two AST selectors.
const useEffect = {
  meta: {
    schema: [],
    messages: {
      try: "Model failures with Effect and tagged errors instead of try/catch.",
      promise: "Compose effects with Effect instead of Promise statics.",
    },
  },
  create(context) {
    return {
      TryStatement(node) {
        context.report({ node, messageId: "try" })
      },
      "CallExpression[callee.object.name='Promise']"(node) {
        context.report({ node, messageId: "promise" })
      },
    }
  },
}

export default { meta: { name: "holyagent-effect" }, rules: { "use-effect": useEffect } }
