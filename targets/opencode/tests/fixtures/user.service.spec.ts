import { Test, TestingModule } from "@nestjs/testing";
import { UserService } from "./user.service";
import { UserRepository } from "./user.repository";
import { getRepositoryToken } from "@nestjs/typeorm";
import { User } from "./user.entity";

describe("UserService", () => {
  let service: UserService;
  let repository: jest.Mocked<UserRepository>;

  beforeEach(async () => {
    const mockRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findAndCount: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(User),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    repository = module.get(getRepositoryToken(User));
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("findAll", () => {
    it("should return an array of users", async () => {
      const users = [{ id: "1", email: "test@example.com" }];
      repository.find.mockResolvedValue(users);

      const result = await service.findAll();

      expect(result).toEqual(users);
      expect(repository.find).toHaveBeenCalled();
    });
  });

  describe("findById", () => {
    it("should return a user by id", async () => {
      const user = { id: "1", email: "test@example.com" };
      repository.findOne.mockResolvedValue(user);

      const result = await service.findById("1");

      expect(result).toEqual(user);
      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: "1" } });
    });

    it("should return null if user not found", async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.findById("999");

      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    it("should create a new user", async () => {
      const createDto = { email: "new@example.com", name: "New User" };
      const savedUser = { id: "1", ...createDto };
      repository.save.mockResolvedValue(savedUser);

      const result = await service.create(createDto);

      expect(result).toEqual(savedUser);
      expect(repository.save).toHaveBeenCalledWith(createDto);
    });
  });

  describe("update", () => {
    it("should update a user", async () => {
      const updateDto = { name: "Updated Name" };
      const updatedUser = { id: "1", email: "test@example.com", ...updateDto };
      repository.update.mockResolvedValue({ affected: 1 } as any);
      repository.findOne.mockResolvedValue(updatedUser);

      const result = await service.update("1", updateDto);

      expect(result).toEqual(updatedUser);
      expect(repository.update).toHaveBeenCalledWith("1", updateDto);
    });
  });

  describe("delete", () => {
    it("should delete a user", async () => {
      repository.delete.mockResolvedValue({ affected: 1 } as any);

      await service.delete("1");

      expect(repository.delete).toHaveBeenCalledWith("1");
    });
  });

  describe("findByEmail", () => {
    it("should find a user by email", async () => {
      const user = { id: "1", email: "test@example.com" };
      repository.findOne.mockResolvedValue(user);

      const result = await service.findByEmail("test@example.com");

      expect(result).toEqual(user);
      expect(repository.findOne).toHaveBeenCalledWith({ where: { email: "test@example.com" } });
    });
  });

  describe("count", () => {
    it("should return the total user count", async () => {
      repository.count.mockResolvedValue(42);

      const result = await service.count();

      expect(result).toBe(42);
      expect(repository.count).toHaveBeenCalled();
    });
  });

  describe("exists", () => {
    it("should return true if user exists", async () => {
      repository.count.mockResolvedValue(1);

      const result = await service.exists("1");

      expect(result).toBe(true);
    });

    it("should return false if user does not exist", async () => {
      repository.count.mockResolvedValue(0);

      const result = await service.exists("999");

      expect(result).toBe(false);
    });
  });

  describe("findActive", () => {
    it("should return only active users", async () => {
      const activeUsers = [{ id: "1", isActive: true }, { id: "2", isActive: true }];
      repository.find.mockResolvedValue(activeUsers);

      const result = await service.findActive();

      expect(result).toEqual(activeUsers);
      expect(repository.find).toHaveBeenCalledWith({ where: { isActive: true } });
    });
  });

  describe("findInactive", () => {
    it("should return only inactive users", async () => {
      const inactiveUsers = [{ id: "1", isActive: false }];
      repository.find.mockResolvedValue(inactiveUsers);

      const result = await service.findInactive();

      expect(result).toEqual(inactiveUsers);
      expect(repository.find).toHaveBeenCalledWith({ where: { isActive: false } });
    });
  });

  describe("activateUser", () => {
    it("should activate a user", async () => {
      repository.update.mockResolvedValue({ affected: 1 } as any);

      await service.activateUser("1");

      expect(repository.update).toHaveBeenCalledWith("1", { isActive: true });
    });
  });

  describe("deactivateUser", () => {
    it("should deactivate a user", async () => {
      repository.update.mockResolvedValue({ affected: 1 } as any);

      await service.deactivateUser("1");

      expect(repository.update).toHaveBeenCalledWith("1", { isActive: false });
    });
  });

  describe("search", () => {
    it("should search users by query", async () => {
      const users = [{ id: "1", email: "test@example.com" }];
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(users),
      };
      repository.createQueryBuilder.mockReturnValue(mockQueryBuilder as any);

      const result = await service.search("test");

      expect(result).toEqual(users);
    });
  });

  describe("findPaginated", () => {
    it("should return paginated users", async () => {
      const users = [{ id: "1" }];
      repository.findAndCount.mockResolvedValue([users, 10]);

      const result = await service.findPaginated(1, 10);

      expect(result.users).toEqual(users);
      expect(result.total).toBe(10);
    });
  });
});
