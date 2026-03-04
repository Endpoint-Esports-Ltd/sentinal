

## NestJS Development Standards

### Architecture

- **Module encapsulation:** Only export what consumers need. Every feature gets its own module.
- **Dependency injection:** Never use `new Service()`. Always inject via constructor.
- **Repository pattern** for data access — services call repositories, never query directly.
- **Custom exceptions** extending `HttpException` — never throw raw `Error` from controllers.

### Controllers

- **One controller per resource** (`users.controller.ts` handles `/users/*`)
- **Swagger decorators on every endpoint:**
  ```typescript
  @ApiTags('users')
  @Controller('users')
  export class UsersController {
    @Get()
    @ApiOperation({ summary: 'List all users' })
    @ApiResponse({ status: 200, type: [UserResponseDto] })
    findAll(): Promise<UserResponseDto[]> { ... }
  }
  ```
- **DTOs for all inputs and outputs** — never expose entities directly
- **Use `@HttpCode()` explicitly** when not using default (200 for GET, 201 for POST)

### DTOs & Validation

- **class-validator decorators** on every DTO property:
  ```typescript
  export class CreateUserDto {
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    name: string;

    @IsEmail()
    email: string;

    @IsOptional()
    @IsString()
    avatar?: string;
  }
  ```
- **Separate Create/Update/Response DTOs** — don't reuse
- **`class-transformer`** for entity-to-DTO mapping
- **Global validation pipe** in `main.ts`:
  ```typescript
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  ```

### Guards & Interceptors

- **Guards** for authentication/authorization:
  ```typescript
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  ```
- **Interceptors** for cross-cutting concerns: logging, caching, response transformation
- **Exception filters** for consistent error responses

### Configuration

- **`@nestjs/config`** with `.env` files and validation:
  ```typescript
  @Module({
    imports: [ConfigModule.forRoot({ validationSchema: Joi.object({...}) })],
  })
  ```
- **Never hardcode** connection strings, secrets, or environment-specific values

### Database

- **TypeORM or Prisma** — stick with one per project
- **Migrations for all schema changes** — never use `synchronize: true` in production
- **Eager loading hints** to prevent N+1 queries
- **Transactions** for multi-step operations:
  ```typescript
  await this.dataSource.transaction(async (manager) => { ... });
  ```

### Testing

- **Unit tests** for services with mocked repositories
- **Integration tests** for controllers using `@nestjs/testing`:
  ```typescript
  const module = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [{ provide: UsersService, useValue: mockService }],
  }).compile();
  ```
- **E2E tests** with `supertest` for full API flow
