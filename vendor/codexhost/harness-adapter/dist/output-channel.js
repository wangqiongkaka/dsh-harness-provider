export class HarnessOutputChannel {
    outputs;
    #consumerCreated = false;
    #ended = false;
    #pending = [];
    #values = [];
    constructor() {
        this.outputs = {
            [Symbol.asyncIterator]: () => {
                if (this.#consumerCreated) {
                    throw new Error("Harness outputs allow only one consumer");
                }
                this.#consumerCreated = true;
                return {
                    next: () => this.#next(),
                };
            },
        };
    }
    emit(value) {
        if (this.#ended)
            return false;
        const resolve = this.#pending.shift();
        if (resolve)
            resolve({ done: false, value });
        else
            this.#values.push(value);
        return true;
    }
    end() {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#values.length !== 0)
            return;
        for (const resolve of this.#pending.splice(0))
            resolve({ done: true, value: undefined });
    }
    #next() {
        const value = this.#values.shift();
        if (value !== undefined)
            return Promise.resolve({ done: false, value });
        if (this.#ended)
            return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#pending.push(resolve));
    }
}
//# sourceMappingURL=output-channel.js.map