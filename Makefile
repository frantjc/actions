YARN = yarn
GIT = git

SEMVER ?= 0.1.0

ifeq (,$(findstring -,$(SEMVER)))
MAJOR = $(word 1,$(subst ., ,$(SEMVER)))
MINOR = $(word 2,$(subst ., ,$(SEMVER)))

release:
	@$(YARN)
	@$(YARN) all
	@$(GIT) add src/ dist/
	@$(GIT) commit -m $(SEMVER)
	@$(YARN) version --new-version $(SEMVER)
	@$(GIT) push
	@$(GIT) tag -f v$(MAJOR)
	@$(GIT) tag -f v$(MAJOR).$(MINOR)
	@$(GIT) push --tags -f
else
release:
	@$(YARN)
	@$(YARN) all
	@$(GIT) add src/ dist/
	@$(GIT) commit -m $(SEMVER)
	@$(YARN) version --new-version $(SEMVER)
	@$(GIT) push
	@$(GIT) push --tags
endif
