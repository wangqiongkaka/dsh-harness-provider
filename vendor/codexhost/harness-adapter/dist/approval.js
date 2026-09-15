function invalidRequest(message) {
    return { code: "invalidRequest", message, retryable: false };
}
export function validateHostApprovalResponse(interaction, response) {
    return interaction.actions.some(({ id }) => id === response.actionId)
        ? null
        : invalidRequest("Approval Response contains an undeclared action ID");
}
//# sourceMappingURL=approval.js.map