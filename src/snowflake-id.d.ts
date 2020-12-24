declare module 'snowflake-id';

declare class Snowflake {
    constructor(options?: object);

    generate(): string;
}