export declare class HarnessOutputChannel<T> {
    #private;
    readonly outputs: AsyncIterable<T>;
    constructor();
    emit(value: T): boolean;
    end(): void;
}
//# sourceMappingURL=output-channel.d.ts.map