import { validateHostApprovalResponse } from "./approval.js";
import { validateHostQuestionResponse } from "./question.js";
function invalidRequest(message) {
    return { code: "invalidRequest", message, retryable: false };
}
function invalidState(message) {
    return { code: "invalidState", message, retryable: false };
}
export function validateHostInteractionResponse(interaction, response) {
    if (!interaction) {
        return invalidState("Interaction Response must reference a pending Interaction");
    }
    if (interaction.type === "question") {
        return response.type === "question"
            ? validateHostQuestionResponse(interaction, response)
            : invalidRequest("Interaction Response type does not match the pending Interaction");
    }
    return response.type === "approval"
        ? validateHostApprovalResponse(interaction, response)
        : invalidRequest("Interaction Response type does not match the pending Interaction");
}
//# sourceMappingURL=interaction.js.map