
export class ParalelizedTest {

    maxParallelTests: number;
    tests: {
        text: string,
        fn: () => Promise<void>
    }[] = [];

    constructor(maxParallelTests: number = 10) {
        this.maxParallelTests = maxParallelTests;
    }

    it(text: string, fn: () => Promise<void>) {
        this.tests.push({
            text,
            fn
        })
    }

    async execute() {

        console.log("Running "+this.tests.length+" tests! Maximum "+this.maxParallelTests+" in parallel!");

        let currentPromise = Promise.resolve<any>({});

        const promises: {
            text: string,
            promise: Promise<void>
        }[] = [];

        let i = 0;
        while(i<this.tests.length) {
            const endIndex = Math.min(i+this.maxParallelTests, this.tests.length);

            const _i = i;
            currentPromise.then(() => console.log("Process tests: "+_i+".."+endIndex));
            const currentPromises = [];
            for(let e=i;e<endIndex;e++) {
                const promise = currentPromise.then(() => this.tests[e].fn());
                currentPromises.push(promise);
                promises.push({
                    text: this.tests[e].text,
                    promise
                });
            }

            currentPromise = Promise.allSettled<any>(currentPromises).catch(e => {});

            i += this.maxParallelTests;
        }

        promises.forEach(({text, promise}) => it(text, () => promise));

    }

}