export interface NestCheckResult {
  severity: "error" | "warning" | "info";
  message: string;
}

const NEST_FILE_PATTERNS = [
  /\.controller\.ts$/, /\.service\.ts$/, /\.module\.ts$/,
  /\.guard\.ts$/, /\.interceptor\.ts$/, /\.dto\.ts$/,
  /\.entity\.ts$/, /\.pipe\.ts$/, /\.filter\.ts$/, /\.middleware\.ts$/,
];

export function isNestFile(filePath: string): boolean {
  return NEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function checkNestPatterns(filePath: string, content: string): NestCheckResult[] {
  const results: NestCheckResult[] = [];

  if (filePath.endsWith(".controller.ts")) {
    if (!content.includes("@ApiTags")) {
      results.push({
        severity: "warning",
        message: "Controller missing @ApiTags decorator. Add Swagger/OpenAPI tags for API documentation.",
      });
    }
  }

  if (filePath.endsWith(".dto.ts")) {
    if (!content.includes("class-validator") && !content.match(/@Is\w+\(/)) {
      results.push({
        severity: "warning",
        message: "DTO missing class-validator decorators. Add validation decorators (@IsString, @IsEmail, etc.) for input validation.",
      });
    }
  }

  if (filePath.endsWith(".entity.ts")) {
    if (!content.includes("@Entity") && !content.includes("@model")) {
      results.push({
        severity: "warning",
        message: "Entity file missing ORM decorator (@Entity for TypeORM, @model for Prisma).",
      });
    }
  }

  return results;
}
